import { watchedKey } from '../lib/watched'
import { useAppStore } from '../store/useAppStore'

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

  if (!openSeries) return null

  const seasons = seriesInfo?.seasons ?? []
  const episodesBySeason = seriesInfo?.episodes ?? {}
  const favorited = isFavorited('series', openSeries.series_id)

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

        {Object.entries(episodesBySeason).map(([seasonKey, episodes]) => {
          const season = seasons.find((s) => String(s.season_number) === seasonKey)
          return (
            <div key={seasonKey} className="season-block">
              <h3>{season?.name ?? `Season ${seasonKey}`}</h3>
              <ul className="episode-list">
                {episodes
                  .slice()
                  .sort((a, b) => a.episode_num - b.episode_num)
                  .map((episode) => {
                    const progress = episodeProgress[episode.id]
                    const percent =
                      progress && progress.durationSeconds > 0
                        ? Math.min(100, (progress.positionSeconds / progress.durationSeconds) * 100)
                        : 0
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
