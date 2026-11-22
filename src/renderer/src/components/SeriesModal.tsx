import { useState } from 'react'
import { watchedKey } from '../lib/watched'
import { defaultSeasonFor, orderedSeasonKeys } from '../lib/nextEpisode'
import { useAppStore } from '../store/useAppStore'
import type { SeriesEpisode } from '../lib/types'

/**
 * The season the viewer last picked, per series, for this session — the lib/previousChannel
 * pattern: a module-level map the renderer keeps for its lifetime. Deliberately NOT a persisted
 * setting: a modal session is short-lived, a saved tab would go stale the moment the provider
 * renumbers seasons, and the default-season rule (below) is the honest answer whenever the
 * viewer has not picked one themselves. Until a tab is clicked, the modal follows
 * defaultSeasonFor live — so marking a season watched walks the default forward on its own.
 */
const rememberedSeasons = new Map<string, string>()

export function SeriesModal(): JSX.Element | null {
  const openSeries = useAppStore((s) => s.openSeries)
  const seriesInfo = useAppStore((s) => s.seriesInfo)
  const seriesInfoLoading = useAppStore((s) => s.seriesInfoLoading)
  const closeSeriesDetail = useAppStore((s) => s.closeSeriesDetail)
  const play = useAppStore((s) => s.play)
  const episodeProgress = useAppStore((s) => s.episodeProgress)
  // Explicit marks (0.23.0), alongside the progress-derived verdict: a position is what the player
  // knows, a mark is what the viewer said, and either one is enough to call an episode watched.
  const watchedTitles = useAppStore((s) => s.watchedTitles)
  const setWatched = useAppStore((s) => s.setWatched)
  const isFavorited = useAppStore((s) => s.isFavorited)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  // The map above remembers between opens, but it cannot re-render anything — this state is the
  // live pick that makes a tab click take effect immediately (and, keyed by series, leaves
  // another series' remembered choice alone).
  const [pickedSeason, setPickedSeason] = useState<{ seriesId: string; key: string } | null>(null)

  if (!openSeries) return null

  const seasons = seriesInfo?.seasons ?? []
  const episodesBySeason = seriesInfo?.episodes ?? {}
  const favorited = isFavorited('series', openSeries.series_id)

  // Watch order puts the numeric seasons first (same ordering the Next button plays); any
  // non-numeric keys a broken provider sent render after them, unchanged, instead of vanishing.
  const numericSeasonKeys = orderedSeasonKeys(seriesInfo)
  const extraSeasonKeys = Object.keys(episodesBySeason).filter((key) => !numericSeasonKeys.includes(key))
  const seasonKeys = [...numericSeasonKeys, ...extraSeasonKeys]

  const percentOf = (episode: SeriesEpisode): number => {
    const progress = episodeProgress[episode.id]
    return progress && progress.durationSeconds > 0
      ? Math.min(100, (progress.positionSeconds / progress.durationSeconds) * 100)
      : 0
  }
  const isEpisodeWatched = (episode: SeriesEpisode): boolean =>
    Boolean(watchedTitles[watchedKey('series', episode.id)]) || percentOf(episode) >= 95

  // Tabs only earn their row when there is more than one season to choose; a single-season series
  // keeps the layout the modal has always had. Hiding (not unmounting) the other blocks keeps
  // their rows mounted, so progress bars and marks never flicker away on a tab switch.
  const multiSeason = seasonKeys.length > 1
  const defaultSeason = multiSeason ? defaultSeasonFor(seriesInfo, isEpisodeWatched) : null
  const remembered = rememberedSeasons.get(String(openSeries.series_id))
  const activeSeasonKey = multiSeason
    ? pickedSeason && pickedSeason.seriesId === String(openSeries.series_id) && seasonKeys.includes(pickedSeason.key)
      ? pickedSeason.key
      : remembered && seasonKeys.includes(remembered)
        ? remembered
        : (numericSeasonKeys.find((key) => Number(key) === defaultSeason) ?? numericSeasonKeys[0] ?? seasonKeys[0])
    : null

  return (
    <div className="modal-overlay" onClick={closeSeriesDetail}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{openSeries.name}</h2>
          <div className="preview-header-actions">
            <button
              className={favorited ? 'favorite-toggle active' : 'favorite-toggle'}
              onClick={() => toggleFavorite({ kind: 'series', item: openSeries })}
              title={favorited ? 'Remove from favorites' : 'Add to favorites'}
            >
              {favorited ? '★' : '☆'}
            </button>
            <button className="modal-close" onClick={closeSeriesDetail}>
              ✕
            </button>
          </div>
        </div>

        {openSeries.plot && <p className="modal-plot">{openSeries.plot}</p>}

        {seriesInfoLoading && <p className="modal-loading">Loading episodes…</p>}

        {!seriesInfoLoading && seasons.length === 0 && Object.keys(episodesBySeason).length === 0 && (
          <p className="modal-loading">No episode data returned by the provider.</p>
        )}

        {multiSeason && (
          <div className="season-tabs" role="tablist">
            {seasonKeys.map((key) => {
              const season = seasons.find((s) => String(s.season_number) === key)
              const active = key === activeSeasonKey
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={active}
                  className={active ? 'season-tab active' : 'season-tab'}
                  onClick={() => {
                    rememberedSeasons.set(String(openSeries.series_id), key)
                    setPickedSeason({ seriesId: String(openSeries.series_id), key })
                  }}
                >
                  {season?.name ?? `Season ${key}`}
                </button>
              )
            })}
          </div>
        )}

        {seasonKeys.map((key) => {
          const season = seasons.find((s) => String(s.season_number) === key)
          const hidden = multiSeason && key !== activeSeasonKey
          return (
            <div key={key} className="season-block" data-season={key} hidden={hidden}>
              <h3>{season?.name ?? `Season ${key}`}</h3>
              <ul className="episode-list">
                {(episodesBySeason[key] ?? [])
                  .slice()
                  .sort((a, b) => a.episode_num - b.episode_num)
                  .map((episode) => {
                    const percent = percentOf(episode)
                    const marked = Boolean(watchedTitles[watchedKey('series', episode.id)])
                    const watched = marked || percent >= 95
                    return (
                      <li key={episode.id}>
                        <button
                          onClick={() => {
                            play(
                              'series',
                              Number(episode.id),
                              `${openSeries.name} — ${episode.title}`,
                              episode.container_extension || 'mp4',
                              // No icon: episodes carry none of their own, and the show's cover
                              // belongs to the modal, not the player.
                              undefined,
                              0,
                              null,
                              // The episode list is already here — hand it to the player so its
                              // "Next episode" button needs no request of its own.
                              seriesInfo ? { id: openSeries.series_id, name: openSeries.name, info: seriesInfo } : undefined
                            )
                            closeSeriesDetail()
                          }}
                        >
                          <span className="episode-label">
                            E{episode.episode_num} · {episode.title}
                            {watched && <span className="episode-watched"> ✓ Watched</span>}
                          </span>
                          {percent > 0 && percent < 95 && (
                            <span className="episode-progress">
                              <span className="episode-progress-fill" style={{ width: `${percent}%` }} />
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className={marked ? 'watched-toggle active' : 'watched-toggle'}
                          aria-pressed={marked}
                          title={marked ? 'Mark this episode unwatched' : 'Mark this episode watched'}
                          onClick={() => setWatched('series', Number(episode.id), !marked)}
                        >
                          {marked ? '✓' : '○'}
                        </button>
                      </li>
                    )
                  })}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}
