import { XMLParser } from 'fast-xml-parser'
import type { LiveStream, ShortEpgProgram } from './types'

export interface EpgChannel {
  id: string
  displayName: string
  icon?: string
}

export interface EpgProgramme {
  channelId: string
  start: Date
  stop: Date
  title: string
  description?: string
}

export interface EpgData {
  channels: Map<string, EpgChannel>
  programmesByChannel: Map<string, EpgProgramme[]>
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function textOf(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text'])
  }
  return String(value)
}

/** XMLTV timestamps look like `20240101120000 +0000`. */
function parseXmltvDate(value: string): Date {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/)
  if (!match) return new Date(value)
  const [, year, month, day, hour, minute, second, offset] = match
  const normalizedOffset = offset ? `${offset.slice(0, 3)}:${offset.slice(3)}` : 'Z'
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${normalizedOffset}`)
}

export function parseXmltv(xml: string): EpgData {
  // fast-xml-parser caps total entity expansions (every &amp;/&quot;/&#8217; in tag values
  // counts) at 1000 by default — a billion-laughs DoS guard that real XMLTV guides trip
  // within their first few dozen channels: a large country guide carries thousands of entity
  // references across titles/descriptions, and hitting the cap aborts the whole parse
  // ("Entity expansion limit exceeded: 1001 > 1000"), making a perfectly healthy source look
  // unavailable. Scale the cap by input size instead: an entity reference is at least 4
  // characters (`&lt;`), so xml.length / 4 is the mathematical maximum any well-formed
  // document can expand — legitimate guides can never be rejected — while small-input
  // amplification stays capped (a 1KB billion-laughs-style file gets a ~251-expansion
  // ceiling, preserving the protection the default existed for). The separate maxEntityCount
  // DOCTYPE-definition cap (default 1000) is untouched and still bounds recursive entities.
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: {
      maxTotalExpansions: Math.floor(xml.length / 4) + 1,
      // Total expanded-entity characters: real guides' expansions never exceed their own
      // source text (named entities shrink), so 2x input plus fixed headroom can't reject a
      // legitimate guide while still bounding adversarial amplification.
      maxExpandedLength: xml.length * 2 + 100000
    }
  })
  // Lenient to preamble: a leading BOM or stray text before the XML root (e.g. a ".txt" file
  // that is really XMLTV with junk on top, which providers do hand out) shouldn't kill the
  // whole guide — everything before the first <?xml/<tv tag is skipped. No XML tag found at
  // all (-1) keeps the input unchanged, producing the empty guide loadEpgSources then flags
  // as "didn't look like an XMLTV guide" rather than a mystery.
  const rootStart = xml.search(/<\?xml|<tv[\s>]/i)
  const doc = parser.parse(rootStart > 0 ? xml.slice(rootStart) : xml) as {
    tv?: { channel?: unknown; programme?: unknown }
  }
  const tv = doc.tv ?? {}

  const channels = new Map<string, EpgChannel>()
  for (const raw of asArray(tv.channel as any)) {
    const id = String(raw['@_id'])
    const displayName = textOf(raw['display-name']) ?? id
    const icon = raw.icon?.['@_src']
    channels.set(id, { id, displayName, icon })
  }

  const programmesByChannel = new Map<string, EpgProgramme[]>()
  for (const raw of asArray(tv.programme as any)) {
    const channelId = String(raw['@_channel'])
    const programme: EpgProgramme = {
      channelId,
      start: parseXmltvDate(String(raw['@_start'])),
      stop: parseXmltvDate(String(raw['@_stop'])),
      title: textOf(raw.title) ?? 'Untitled',
      description: textOf(raw.desc)
    }
    const list = programmesByChannel.get(channelId)
    if (list) {
      list.push(programme)
    } else {
      programmesByChannel.set(channelId, [programme])
    }
  }

  for (const list of programmesByChannel.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime())
  }

  return { channels, programmesByChannel }
}

export function getCurrentProgramme(
  programmes: EpgProgramme[] | undefined,
  at: Date = new Date()
): EpgProgramme | undefined {
  return programmes?.find((p) => p.start <= at && at < p.stop)
}

export function getNextProgramme(
  programmes: EpgProgramme[] | undefined,
  at: Date = new Date()
): EpgProgramme | undefined {
  return programmes?.find((p) => p.start > at)
}

/**
 * Maps one XMLTV channel's programmes into the ShortEpgProgram shape every EPG surface in this
 * app renders — the exact same mapping M3uClient.getShortEpg has always done for its own guide,
 * extracted here so the multi-source guide pool (see useAppStore.loadEpgSources) reuses it
 * instead of duplicating it. Entries with unparseable timestamps or a stop at/before their
 * start are dropped here rather than rendering as invisible NaN-positioned blocks later.
 * Programmes that have already ended are filtered out: every consumer's contract is "now
 * onward" (mirroring get_short_epg's own), and later days' worth of data is exactly the point
 * of the pool.
 */
export function xmltvProgrammesToShort(
  programmes: EpgProgramme[],
  channelId: string,
  now: Date = new Date()
): ShortEpgProgram[] {
  return programmes
    .filter((p) => {
      const start = p.start.getTime()
      const stop = p.stop.getTime()
      return !Number.isNaN(start) && !Number.isNaN(stop) && stop > start && stop >= now.getTime()
    })
    .map((p) => ({
      // Channel+start makes the id unique across sources and stable across refreshes — what
      // the reminder feature (isEpgReminderSet) keys off.
      id: `xmltv-${channelId}-${Math.floor(p.start.getTime() / 1000)}`,
      epg_id: channelId,
      title: p.title,
      lang: '',
      start: p.start.toISOString(),
      end: p.stop.toISOString(),
      description: p.description ?? '',
      channel_id: channelId,
      start_timestamp: String(Math.floor(p.start.getTime() / 1000)),
      stop_timestamp: String(Math.floor(p.stop.getTime() / 1000))
    }))
}

/**
 * Merges per-channel provider short EPG (primary) with the multi-source guide pool's entry for
 * that channel (secondary): primary entries always win; secondary entries that overlap any
 * primary entry in time are dropped (the provider's own view of the same slot is fresher);
 * everything else from the pool — later days, gaps the provider's short window doesn't cover —
 * is appended, sorted by start time. This is what turns "rest of today only" into a complete
 * multi-day timeline whenever a full guide is available.
 */
export function mergeShortEpg(primary: ShortEpgProgram[], secondary: ShortEpgProgram[] = []): ShortEpgProgram[] {
  const primaryRanges = primary.map((p) => ({
    start: Number(p.start_timestamp) * 1000,
    stop: Number(p.stop_timestamp) * 1000
  }))
  const overlapsPrimary = (programme: ShortEpgProgram): boolean => {
    const start = Number(programme.start_timestamp) * 1000
    const stop = Number(programme.stop_timestamp) * 1000
    if (Number.isNaN(start) || Number.isNaN(stop)) return true // unparseable — drop rather than misplace
    return primaryRanges.some((r) => start < r.stop && r.start < stop)
  }
  return [...primary, ...secondary.filter((p) => !overlapsPrimary(p))].sort(
    (a, b) => Number(a.start_timestamp) - Number(b.start_timestamp)
  )
}

/**
 * Decodes a fetched EPG document's bytes, transparently handling the gzipped form many guide
 * providers serve (.xml.gz files — where the gzip is the file itself, NOT a Content-Encoding
 * transfer fetch would already have decompressed). Detection is by gzip magic bytes (1f 8b)
 * rather than URL extension or content-type: providers label these inconsistently (text/plain,
 * application/octet-stream, …) and URLs carry query strings, but the two leading bytes are
 * unambiguous — plain XML never starts with them, and a transfer-level gzip has already been
 * transparently decoded by fetch before the bytes get here, so there's no double-decompression
 * risk either.
 */
export async function decodeMaybeGzipBytes(buffer: ArrayBuffer): Promise<string> {
  if (buffer.byteLength < 2) return new TextDecoder().decode(buffer)
  const head = new Uint8Array(buffer, 0, 2)
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
    return new Response(stream).text()
  }
  return new TextDecoder().decode(buffer)
}

/**
 * The Settings ▸ EPG sources list is the UNION of what's persisted and what's actually live in
 * the store's guide pool — those two can only disagree through a state round-trip bug, and the
 * failure mode when they do is exactly "a source the app is still fetching is invisible (and
 * undeletable) in Settings". Persisted URLs come first in their saved order; any live label
 * that isn't persisted is appended so it stays visible and removable. The provider's own guide
 * is never listed — it isn't user-added, and can't be removed.
 */
export function unionEpgSourceUrls(customUrls: string[], liveLabels: string[], providerLabel: string): string[] {
  const result = [...customUrls]
  for (const label of liveLabels) {
    if (label === providerLabel) continue
    if (!result.includes(label)) result.push(label)
  }
  return result
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** One matched channel: which guide channel it resolved to, and by which join method. */
export interface XmltvChannelMatch {
  channelId: string
  method: 'id' | 'name' | 'manual'
}

/**
 * Indexes this app's live channels against one XMLTV guide's own channel list — the join that
 * makes third-party guides usable at all, since their channel ids follow their own convention
 * (e.g. iptv-org's "BBCOne.uk"), not the provider's. Matching, first match wins:
 *   0. a manual mapping for this stream (Settings ▸ EPG sources ▸ Map channels) whose guide
 *      channel id actually exists in this guide — the user's explicit "this guide channel is
 *      this channel" always outranks any automatic guess. A mapping pointing at a channel the
 *      guide no longer contains (the source renumbered its ids) falls through to the automatic
 *      joins rather than silently dropping the channel, and gets re-fixed next time the user
 *      opens the mapping editor.
 *   1. epg_channel_id exactly equals the guide's channel id (Xtream providers that publish the
 *      same id in both get_live_streams and their xmltv.php; M3U playlists' tvg-id, which
 *      M3uClient already stores in epg_channel_id)
 *   2. the guide channel's display-name normalized-equals the stream's name (the practical
 *      cross-provider join: most guides label channels the way users see them)
 * Only the first guide channel matching a given stream wins, so a guide with both "BBC One"
 * and "BBC One HD" resolves deterministically rather than double-booking one stream. The
 * method is reported alongside each match so callers can surface how much of a source's
 * matching rests on the weaker name join (or on manual fixes). manualMappings is keyed by
 * streamId → guide channel id; several streams may share one guide channel (HD/SD twins off
 * the same feed), but each stream resolves to at most one guide channel here.
 */
export function matchXmltvChannels(
  liveStreams: LiveStream[],
  epg: EpgData,
  manualMappings?: Map<number, string>
): Map<number, XmltvChannelMatch> {
  const matches = new Map<number, XmltvChannelMatch>()
  const byNormName = new Map<string, string>()
  for (const [id, channel] of epg.channels) {
    const normalized = normalizeName(channel.displayName)
    if (normalized && !byNormName.has(normalized)) byNormName.set(normalized, id)
  }
  for (const stream of liveStreams) {
    if (matches.has(stream.stream_id)) continue
    const manualChannelId = manualMappings?.get(stream.stream_id)
    if (manualChannelId && epg.channels.has(manualChannelId)) {
      matches.set(stream.stream_id, { channelId: manualChannelId, method: 'manual' })
      continue
    }
    if (stream.epg_channel_id && epg.channels.has(stream.epg_channel_id)) {
      matches.set(stream.stream_id, { channelId: stream.epg_channel_id, method: 'id' })
      continue
    }
    const normalized = normalizeName(stream.name)
    const byName = normalized ? byNormName.get(normalized) : undefined
    if (byName) matches.set(stream.stream_id, { channelId: byName, method: 'name' })
  }
  return matches
}
