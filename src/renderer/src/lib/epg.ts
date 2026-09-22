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
 * The Guide & EPG source list is the UNION of what's persisted and what's actually live in
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

// Tokens that carry no identity — quality/format tags, connection metadata, and channel-list
// position noise that Xtream providers prepend/append to names ("101 BBC One HD", "UK: Sky
// Sports FHD (VIP)", "HBO US"). Only ever used by the RELAXED fuzzy tier (never the exact
// name join), and only after both sides went through the exact normalizer first, so a token
// like "4music" (where 4 is inside the word) is untouched — standalone digits alone drop.
const FUZZY_NOISE_TOKENS = new Set([
  'hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h265', 'h264', 'av1', 'hdr', 'hlg',
  'vip', 'backup', 'feed', 'raw', 'uk', 'us', 'and'
])

/**
 * Relaxed channel-name normalization for the fuzzy join tier: diacritic-folded (café → cafe),
 * "&"/"and" unified, tokenized, then noise tokens (FUZZY_NOISE_TOKENS above) and standalone
 * numbers (channel-list positions: "101 BBC One" → "bbc one") dropped, and the remaining
 * tokens sorted so token ORDER can't block a match ("Sky Sports Main Event" vs "Main Event
 * Sky Sports"). Both sides of the join go through the exact same pipeline, so equality here
 * means "same channel modulo presentation noise", not "similar-looking".
 */
function looseTokens(value: string): string[] {
  const folded = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
  return folded
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .filter((t) => !FUZZY_NOISE_TOKENS.has(t) && !/^\d+$/.test(t))
}

function normalizeNameLoose(value: string): string {
  return looseTokens(value).sort().join(' ')
}

/**
 * Prebuilt lookup tables for one guide — the shared core of every join tier AND of the mapping
 * editor's suggestion / "find the unmatched ones" features. Building it walks the guide's
 * channels once and pays the Unicode-normalization cost for each; callers that resolve many
 * streams (a 24k-30k catalog) must build it ONCE and reuse it, never per stream — doing the
 * loose normalization 30,000 times against a channelless guide is exactly the kind of thing
 * that turns a checkbox into a two-second freeze.
 */
export interface GuideIndex {
  /** guide channel id → channel (id-tier joins and display names) */
  channels: Map<string, EpgChannel>
  /** guide channel id → how many programmes it carries (0 = a guide entry with no listings) */
  programmeCounts: Map<string, number>
  byExactName: Map<string, string>
  byLooseName: Map<string, string>
  /** guide channel id → its loose token set (suggestion scoring) */
  tokensById: Map<string, Set<string>>
  /** loose token → ids of the guide channels containing it, in guide order. Lets suggestion
   * scoring and the bulk planner consider only channels that share at least one token, instead
   * of scanning every channel in the guide for every lookup — the difference between a click
   * that responds instantly on a 5,000-channel guide and one that takes seconds across a
   * 30,000-channel catalog's unmatched residue. */
  channelsByToken: Map<string, string[]>
  /** guide channel id → its position in the guide (stable tie-break for equal suggestions) */
  orderById: Map<string, number>
}

export function buildGuideIndex(epg: EpgData): GuideIndex {
  const channels = new Map(epg.channels)
  const programmeCounts = new Map<string, number>()
  for (const [id, programmes] of epg.programmesByChannel) programmeCounts.set(id, programmes.length)
  const byExactName = new Map<string, string>()
  const byLooseName = new Map<string, string>()
  const tokensById = new Map<string, Set<string>>()
  const channelsByToken = new Map<string, string[]>()
  const orderById = new Map<string, number>()
  let order = 0
  for (const [id, channel] of epg.channels) {
    const exact = normalizeName(channel.displayName)
    if (exact && !byExactName.has(exact)) byExactName.set(exact, id)
    const tokens = new Set(looseTokens(channel.displayName))
    tokensById.set(id, tokens)
    orderById.set(id, order++)
    for (const token of tokens) {
      const posting = channelsByToken.get(token)
      if (posting) posting.push(id)
      else channelsByToken.set(token, [id])
    }
    // Same first-wins rule as the exact map, so a guide carrying both "BBC One" and a noisy
    // variant resolves deterministically.
    const loose = [...tokens].sort().join(' ')
    if (loose && !byLooseName.has(loose)) byLooseName.set(loose, id)
  }
  return { channels, programmeCounts, byExactName, byLooseName, tokensById, channelsByToken, orderById }
}

/** One stream resolved against one guide — matched channel, join method, and whether that
 * guide channel actually has programmes (a match with zero programmes is NOT resolved data;
 * this is the same rule the store's match report uses). null = nothing matched at all. */
export interface StreamGuideResolution {
  channelId: string
  method: XmltvChannelMatch['method']
  programmeCount: number
}

/**
 * The single tier ladder, in one place: manual → EPG id → exact name → relaxed loose match.
 * A manual mapping pointing at a channel the guide no longer contains falls through to the
 * automatic tiers rather than dropping the channel. Shared by matchXmltvChannels (the store)
 * and by Settings' mapping editor (resolving a whole catalog for the "unmatched only" filter),
 * so both surfaces always agree on what "matched" means.
 */
export function resolveStreamToGuide(
  stream: LiveStream,
  index: GuideIndex,
  manualChannelId?: string
): StreamGuideResolution | null {
  const resolved = (channelId: string, method: XmltvChannelMatch['method']): StreamGuideResolution => ({
    channelId,
    method,
    programmeCount: index.programmeCounts.get(channelId) ?? 0
  })
  if (manualChannelId && index.channels.has(manualChannelId)) return resolved(manualChannelId, 'manual')
  if (stream.epg_channel_id && index.channels.has(stream.epg_channel_id)) return resolved(stream.epg_channel_id, 'id')
  const exact = normalizeName(stream.name)
  const byName = exact ? index.byExactName.get(exact) : undefined
  if (byName) return resolved(byName, 'name')
  // Relaxed tier — the one that moves the needle on 24k-30k channel catalogs, where provider
  // names carry quality tags, leading positions and country prefixes the guides never do.
  const loose = normalizeNameLoose(stream.name)
  const byFuzzy = loose ? index.byLooseName.get(loose) : undefined
  if (byFuzzy) return resolved(byFuzzy, 'fuzzy')
  return null
}

/** One ranked suggestion for a stream that has no automatic match. */
export interface GuideCandidate {
  channelId: string
  displayName: string
  score: number
}

// Suggestions only offer candidates sharing at least 60% of their combined tokens. Calibrated
// against the obvious false positive: "BBC One" vs "BBC Two" share exactly one generic token
// ("bbc") and score 0.5 — offering that as a suggestion is a coin flip, not a suggestion, so
// the floor sits above it. Genuine near-misses stay well clear ("101 BBC One HD London" vs
// "BBC One" scores 0.8; a quality-suffix-only difference scores 1.0). The picker's own search
// covers anything this deliberately refuses.
const SUGGESTION_MIN_SCORE = 0.6

/**
 * Ranks a guide's channels against a stream name by Dice similarity over the loose token sets
 * (2·|shared| / |A|+|B|) — the same normalization the relaxed join uses, so "101 BBC One HD"
 * scores 1.0 against "BBC One" and 0 against "BBC Two". Best-first, capped at `limit`; ties
 * break on display name so the order is stable. Used by the mapping editor to turn the
 * residual unmatched channels into one-click fixes.
 */
export function suggestGuideChannels(
  streamName: string,
  index: GuideIndex,
  limit = 3,
  // The floor is a parameter for one caller only: the per-channel match panel, which deliberately
  // offers *weaker* candidates than this function's default would, because it labels each one with
  // its score and a human is choosing. Everywhere else keeps the calibrated default (see
  // SUGGESTION_MIN_SCORE) — an automatic join must not act on a coin flip, a person may.
  minScore = SUGGESTION_MIN_SCORE
): GuideCandidate[] {
  const tokens = new Set(looseTokens(streamName))
  if (tokens.size === 0) return []
  // Only channels sharing at least one token can score above zero, so candidate gathering reads
  // the token postings and de-duplicates, rather than walking the whole guide.
  const candidateIds: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    for (const id of index.channelsByToken.get(token) ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      candidateIds.push(id)
    }
  }
  const scored: GuideCandidate[] = []
  for (const id of candidateIds) {
    const guideTokens = index.tokensById.get(id)
    if (!guideTokens || guideTokens.size === 0) continue
    let shared = 0
    for (const token of tokens) if (guideTokens.has(token)) shared += 1
    if (shared === 0) continue
    const score = (2 * shared) / (tokens.size + guideTokens.size)
    if (score < minScore) continue
    scored.push({ channelId: id, displayName: index.channels.get(id)?.displayName ?? id, score })
  }
  // Score, then display name, then guide position — the last one keeps results identical to the
  // pre-postings implementation (which saw channels in guide order) when two candidates tie on
  // score AND name, and keeps the order stable across runs regardless of token iteration order.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.displayName.localeCompare(b.displayName) ||
      (index.orderById.get(a.channelId) ?? 0) - (index.orderById.get(b.channelId) ?? 0)
  )
  return scored.slice(0, limit)
}

/** What a bulk suggestion run did — shown in the mapping editor so the action is never a mystery. */
export interface BulkSuggestionPlan {
  /** Mappings to create: the best candidate at or above the threshold, per unmatched channel. */
  applied: Array<{ streamId: number; channelId: string; score: number }>
  /** Channels with no usable listings from this source (the pool the planner worked from). */
  considered: number
  /** Skipped because a manual mapping already exists for them. */
  alreadyMapped: number
  /** Unmatched, but nothing scored high enough to apply automatically. */
  belowThreshold: number
}

/**
 * Plans a bulk "apply the good suggestions" run for one source: walks the catalog, ignores
 * channels a manual mapping already covers (the user's own decisions are never overwritten) and
 * channels the automatic tiers already resolve WITH programmes (nothing to fix), and for the
 * rest takes the single best suggestion when it scores at or above `threshold`.
 *
 * Deliberately conservative: one mapping per channel, only above the threshold, and the score is
 * returned so the caller can report what happened. Nothing is applied here — the store does that,
 * so this stays pure and testable. Cost is one loose normalization per unmatched channel plus
 * postings lookups; on a 30k catalog that's a few hundred milliseconds at worst, which is why the
 * UI runs it behind an explicit button rather than on render.
 */
export function planBulkSuggestionApply(
  streams: LiveStream[],
  index: GuideIndex,
  manualByStreamId: Map<number, string>,
  threshold = 0.8
): BulkSuggestionPlan {
  const applied: Array<{ streamId: number; channelId: string; score: number }> = []
  let considered = 0
  let alreadyMapped = 0
  let belowThreshold = 0
  for (const stream of streams) {
    if (manualByStreamId.has(stream.stream_id)) {
      alreadyMapped += 1
      continue
    }
    const resolved = resolveStreamToGuide(stream, index)
    if (resolved && resolved.programmeCount > 0) continue
    considered += 1
    const best = suggestGuideChannels(stream.name, index, 1)[0]
    if (best && best.score >= threshold) {
      applied.push({ streamId: stream.stream_id, channelId: best.channelId, score: best.score })
    } else {
      belowThreshold += 1
    }
  }
  return { applied, considered, alreadyMapped, belowThreshold }
}

/** One matched channel: which guide channel it resolved to, and by which join method. */
export interface XmltvChannelMatch {
  channelId: string
  method: 'id' | 'name' | 'manual' | 'fuzzy'
}

/**
 * Indexes this app's live channels against one XMLTV guide's own channel list — the join that
 * makes third-party guides usable at all, since their channel ids follow their own convention
 * (e.g. iptv-org's "BBCOne.uk"), not the provider's. Matching, first match wins:
 *   0. a manual mapping for this stream (Guide & EPG ▸ Map channels) whose guide
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
 *   3. RELAXED: normalized-loose equality — diacritic-folded, "&"≡"and", noise tokens
 *      (HD/FHD/4K/HEVC/VIP/backup/UK:/US…, standalone numbers) dropped, remaining tokens
 *      sorted — so "101 BBC One HD" joins "BBC One" and "Sky Sports FHD (UK)" joins "Sky
 *      Sports". Built for 24k-30k channel catalogs where most names carry presentation
 *      noise; reported as its own method so the match report shows how much rests on it.
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
  const index = buildGuideIndex(epg)
  const matches = new Map<number, XmltvChannelMatch>()
  for (const stream of liveStreams) {
    if (matches.has(stream.stream_id)) continue
    const resolved = resolveStreamToGuide(stream, index, manualMappings?.get(stream.stream_id))
    if (resolved) matches.set(stream.stream_id, { channelId: resolved.channelId, method: resolved.method })
  }
  return matches
}
