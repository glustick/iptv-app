/**
 * Guide search for the ⌘K palette (0.27.0): "what's on (or about to be) anything" as one query.
 *
 * The guide pool is already in memory (epgSources — see the store), so like the catalogue search
 * beside it (lib/globalSearch) this is a filter, not a request. The join back to provider channels
 * is the same one the grid uses — matchXmltvChannels' tier ladder (EPG id → exact name → relaxed,
 * plus manual mappings) — so a programme hit always names a channel this app can actually play.
 *
 * Cost is the thing to design around: the real guide is ~178MB of XML across ~11,000 channels, so
 * the index is built ONCE per guide/catalogue change (memoized by the caller — see SearchPalette)
 * with every title pre-folded, and a keystroke only scans that flat list. Nothing here re-indexes
 * per query, and the two-character floor matches the palette's own.
 */
import { matchXmltvChannels, xmltvProgrammesToShort, type EpgData } from './epg'
import { foldForSearch } from './globalSearch'
import { channelKey } from './channelIdentity'
import type { EpgChannelMapping, LiveStream, ShortEpgProgram } from './types'

// How many now-or-future programmes to index per channel, and how far ahead to look — both are
// properties of the RANGE the search is answering, not constants (0.33.0). A real guide carries
// days of listings per channel (~178MB across ~11,000 channels); "Now" keeps 0.27.0's exact
// behaviour (the first 48 now-or-future entries per channel, roughly the next day or two at a
// half-hour cadence, no horizon cut), while the wider ranges raise the horizon AND the cap
// together so the bounds stay honest at both ends:
//   - 24h: horizon 24h, cap 48 — a half-hour cadence day is exactly 48 programmes; an hour
//     cadence channel needs only 24, so 48 covers every real cadence inside one day.
//   - 3d: horizon 3 days, cap 144 — three of the 24h bounds.
//   - 7d: horizon 7 days, cap 336 — seven of them. Worst case that is ~3.7M entries across
//     11,000 channels, which is exactly why the index is built per range (the caller memoizes
//     on the range; "Now" never pays for the weekend) and why the cap exists at all: most real
//     guides only carry a few days per channel, and the ones that carry more are trimmed here
//     rather than allowed to pour a whole week of a whole provider into memory.
export type GuideSearchRange = 'now' | '24h' | '3d' | '7d'

interface RangeBound {
  /** Milliseconds ahead of `now` a programme may start; null keeps the original no-cut behaviour. */
  horizonMs: number | null
  maxPerChannel: number
}

const RANGE_BOUNDS: Record<GuideSearchRange, RangeBound> = {
  now: { horizonMs: null, maxPerChannel: 48 },
  '24h': { horizonMs: 24 * 3_600_000, maxPerChannel: 48 },
  '3d': { horizonMs: 3 * 24 * 3_600_000, maxPerChannel: 144 },
  '7d': { horizonMs: 7 * 24 * 3_600_000, maxPerChannel: 336 }
}

/** The segmented control's own options, in display order — labels are the palette's wording. */
export const GUIDE_SEARCH_RANGE_OPTIONS: { id: GuideSearchRange; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: '24h', label: '24h' },
  { id: '3d', label: '3d' },
  { id: '7d', label: '7d' }
]

// The first line of a description, truncated at 80 characters — same-titled episodes are often
// otherwise indistinguishable in a flat result list. 80 keeps a hit to one readable line even at
// the palette's width, and the first line alone (not the first 80 chars of the whole paragraph)
// is what a human scanning results actually compares between two episodes.
const SNIPPET_MAX = 80

export function descriptionSnippet(description: string | undefined): string {
  const firstLine = (description ?? '').split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  if (firstLine.length <= SNIPPET_MAX) return firstLine
  return `${firstLine.slice(0, SNIPPET_MAX).trimEnd()}…`
}

/** One searchable programme, pre-folded — the index's flat row. */
export interface GuideSearchEntry {
  /** Case/accent-folded title — folding at build time is the whole point of the index. */
  foldedTitle: string
  startMs: number
  stopMs: number
  /** The provider channel this programme belongs to — what a hit plays or reminds on. */
  stream: LiveStream
  /** The programme in the ShortEpgProgram shape reminders (toggleEpgReminder) already take. */
  program: ShortEpgProgram
}

/** Build parameters mirror the store's own guide-pool inputs so the two can never disagree. */
export interface GuideSearchIndexInput {
  liveStreams: LiveStream[]
  epgSources: EpgData[]
  /** Index-aligned source labels — manual mappings and hidden-source checks key off these. */
  epgSourceLabels: string[]
  hiddenSourceUrls: string[]
  manualMappings: EpgChannelMapping[]
  primaryPlaylistId: string | null
  now?: Date
}

export interface GuideSearchIndex {
  entries: GuideSearchEntry[]
}

export function buildGuideSearchIndex(
  input: GuideSearchIndexInput,
  range: GuideSearchRange = 'now'
): GuideSearchIndex {
  const { liveStreams, epgSources, epgSourceLabels, hiddenSourceUrls, manualMappings, primaryPlaylistId } = input
  const now = input.now ?? new Date()
  const { horizonMs, maxPerChannel } = RANGE_BOUNDS[range]
  const horizonStartMs = horizonMs === null ? Infinity : now.getTime() + horizonMs
  const entries: GuideSearchEntry[] = []
  if (liveStreams.length === 0 || epgSources.length === 0) return { entries }
  // Manual mappings are playlist-scoped exactly the way applyEpgPool scopes them: a mapping only
  // applies if it names a channel actually in the browsed list, matched by its playlist-aware key.
  const liveKeys = new Set(
    liveStreams.map((stream) => channelKey(stream.playlistId, stream.stream_id, primaryPlaylistId))
  )
  // First source (in the pool's priority order) with programmes for a channel owns it — the same
  // rule that decides which source's listings the grid shows, so search and grid can never offer
  // two different programmes for the same slot from two sources.
  const claimedStreamIds = new Set<number>()
  epgSources.forEach((source, index) => {
    const sourceUrl = epgSourceLabels[index]
    if (hiddenSourceUrls.includes(sourceUrl)) return
    const manual = new Map(
      manualMappings
        .filter(
          (m) =>
            m.sourceUrl === sourceUrl && liveKeys.has(channelKey(m.playlistId, m.streamId, primaryPlaylistId))
        )
        .map((m) => [m.streamId, m.guideChannelId])
    )
    const matches = matchXmltvChannels(liveStreams, source, manual)
    for (const stream of liveStreams) {
      if (claimedStreamIds.has(stream.stream_id)) continue
      const match = matches.get(stream.stream_id)
      if (!match) continue
      const programmes = source.programmesByChannel.get(match.channelId)
      if (!programmes?.length) continue
      claimedStreamIds.add(stream.stream_id)
      // xmltvProgrammesToShort already drops everything that has ended — "on now or upcoming" is
      // its own contract, shared with the grid. The range's horizon then trims the far end (a
      // start beyond it can never answer this range's question) before the per-channel cap is
      // taken from the FRONT, so near programmes are always preferred over distant ones.
      for (const program of xmltvProgrammesToShort(programmes, match.channelId, now)
        .filter((program) => Number(program.start_timestamp) * 1000 < horizonStartMs)
        .slice(0, maxPerChannel)) {
        entries.push({
          foldedTitle: foldForSearch(program.title),
          startMs: Number(program.start_timestamp) * 1000,
          stopMs: Number(program.stop_timestamp) * 1000,
          stream,
          program
        })
      }
    }
  })
  return { entries }
}

export interface GuideProgrammeHit {
  stream: LiveStream
  program: ShortEpgProgram
  startMs: number
  stopMs: number
  /** On air right now (start <= now < stop) — what a hit does on Enter depends on this. */
  onAir: boolean
  /** First line of the description, truncated — the only thing distinguishing same-titled episodes. */
  descriptionSnippet: string
}

/**
 * Titles containing the query (case/accent-folded), on-air first and then soonest to start —
 * "what's on" before "what's coming", and among what's coming, the nearest first. Two-character
 * floor like the palette's catalogue search; capped (default 30) so a broad query ("News") can't
 * pour the whole guide into the list.
 */
export function searchGuideProgrammes(
  index: GuideSearchIndex,
  query: string,
  now: Date = new Date(),
  limit = 30
): GuideProgrammeHit[] {
  const needle = foldForSearch(query)
  if (needle.length < 2) return []
  const nowMs = now.getTime()
  const hits: GuideProgrammeHit[] = []
  for (const entry of index.entries) {
    if (!entry.foldedTitle.includes(needle)) continue
    hits.push({
      stream: entry.stream,
      program: entry.program,
      startMs: entry.startMs,
      stopMs: entry.stopMs,
      onAir: entry.startMs <= nowMs && nowMs < entry.stopMs,
      descriptionSnippet: descriptionSnippet(entry.program.description)
    })
  }
  hits.sort((a, b) => Number(b.onAir) - Number(a.onAir) || a.startMs - b.startMs)
  return hits.slice(0, Math.max(0, limit))
}
