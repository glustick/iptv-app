import type { SeriesEpisode, SeriesInfo } from './types'

/** Numeric ordering, with a stable fallback for anything the provider left non-numeric. */
function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Every episode of a series, in the order a viewer would watch them.
 *
 * The provider's own numbering is neither sorted nor contiguous — the web sibling hit this
 * first (allison-web-iptv v0.95.0) — so seasons sort numerically rather than by object key
 * order (which puts "10" before "2"), and episodes sort by their own episode_num. An empty
 * season simply contributes nothing, which is what lets nextEpisode cross it.
 */
export function orderedEpisodes(info: SeriesInfo | null | undefined): SeriesEpisode[] {
  if (!info || !info.episodes) return []
  const seasons = Object.keys(info.episodes)
    .map((key) => ({ key, season: numeric(key) }))
    .filter((entry) => Number.isFinite(Number(entry.key)))
    .sort((a, b) => a.season - b.season)

  const ordered: SeriesEpisode[] = []
  for (const { key } of seasons) {
    const episodes = Array.isArray(info.episodes[key]) ? info.episodes[key].slice() : []
    episodes.sort((a, b) => numeric(a.episode_num) - numeric(b.episode_num))
    ordered.push(...episodes)
  }
  return ordered
}

/**
 * The episode after this one, crossing into the next season that actually has episodes, or null
 * at the end of the series — never a wrap back to the pilot. An id that is not in the list
 * answers null rather than guessing: playing the wrong episode is worse than offering nothing.
 */
export function nextEpisode(
  info: SeriesInfo | null | undefined,
  currentEpisodeId: number | string
): SeriesEpisode | null {
  const ordered = orderedEpisodes(info)
  const index = ordered.findIndex((episode) => String(episode.id) === String(currentEpisodeId))
  if (index === -1) return null
  return ordered[index + 1] ?? null
}
