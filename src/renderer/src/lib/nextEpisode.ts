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
/**
 * The season keys of a series, in watch order — the numeric sort orderedEpisodes walks, exported
 * so the series modal's tabs and its default-season rule read the very same ordering the Next
 * button plays (0.48.0). Non-numeric keys are provider garbage and stay out, exactly as here.
 */
export function orderedSeasonKeys(info: SeriesInfo | null | undefined): string[] {
  if (!info || !info.episodes) return []
  return Object.keys(info.episodes)
    .filter((key) => Number.isFinite(Number(key)))
    .sort((a, b) => numeric(a) - numeric(b))
}

function episodesOfSeason(info: SeriesInfo, key: string): SeriesEpisode[] {
  const episodes = Array.isArray(info.episodes[key]) ? info.episodes[key].slice() : []
  episodes.sort((a, b) => numeric(a.episode_num) - numeric(b.episode_num))
  return episodes
}

export function orderedEpisodes(info: SeriesInfo | null | undefined): SeriesEpisode[] {
  const ordered: SeriesEpisode[] = []
  for (const key of orderedSeasonKeys(info)) {
    if (info) ordered.push(...episodesOfSeason(info, key))
  }
  return ordered
}

/**
 * The season a returning viewer should land on when the series modal opens (0.48.0): the season
 * holding the first still-unwatched episode in watch order — where they left off. Everything
 * already watched answers the first season (rewatching starts at the pilot, which is where a
 * fully-watched show's next unwatched episode would be if it had one). Fewer than two seasons —
 * or no usable data at all — answers null: one season needs no tabs, and the modal keeps today's
 * single-block layout.
 *
 * What counts as watched is the caller's business (the modal adds explicit marks to progress);
 * this only owns the order, which is nextEpisode's own — the default tab and the Next button can
 * never disagree about where a viewer is.
 */
export function defaultSeasonFor(
  info: SeriesInfo | null | undefined,
  watched: (episode: SeriesEpisode) => boolean
): number | null {
  const keys = orderedSeasonKeys(info)
  if (!info || keys.length < 2) return null
  for (const key of keys) {
    if (episodesOfSeason(info, key).some((episode) => !watched(episode))) return numeric(key)
  }
  return numeric(keys[0])
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
