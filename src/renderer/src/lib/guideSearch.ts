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

// How many now-or-future programmes to index per channel. A real guide carries days of listings
// per channel; the palette answers "what's on / what's coming up", not "what airs Thursday", so
// the first few dozen entries per channel (roughly the next day or two at a half-hour cadence)
// cover the question while bounding the index against a 178MB guide. The cap is honest and stated
// in the roadmap entry rather than hidden.
const MAX_PROGRAMMES_PER_CHANNEL = 48

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

export function buildGuideSearchIndex(input: GuideSearchIndexInput): GuideSearchIndex {
  const { liveStreams, epgSources, epgSourceLabels, hiddenSourceUrls, manualMappings, primaryPlaylistId } = input
  const now = input.now ?? new Date()
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
      // its own contract, shared with the grid.
      for (const program of xmltvProgrammesToShort(programmes, match.channelId, now).slice(
        0,
        MAX_PROGRAMMES_PER_CHANNEL
      )) {
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
      onAir: entry.startMs <= nowMs && nowMs < entry.stopMs
    })
  }
  hits.sort((a, b) => Number(b.onAir) - Number(a.onAir) || a.startMs - b.startMs)
  return hits.slice(0, Math.max(0, limit))
}
