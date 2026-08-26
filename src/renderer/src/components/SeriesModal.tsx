import { useAppStore } from '../store/useAppStore'

export function SeriesModal(): JSX.Element | null {
  const openSeries = useAppStore((s) => s.openSeries)
  const seriesInfo = useAppStore((s) => s.seriesInfo)
  const seriesInfoLoading = useAppStore((s) => s.seriesInfoLoading)
  const closeSeriesDetail = useAppStore((s) => s.closeSeriesDetail)
  const play = useAppStore((s) => s.play)

  if (!openSeries) return null

  const seasons = seriesInfo?.seasons ?? []
  const episodesBySeason = seriesInfo?.episodes ?? {}

  return (
    <div className="modal-overlay" onClick={closeSeriesDetail}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{openSeries.name}</h2>
          <button className="modal-close" onClick={closeSeriesDetail}>
            ✕
          </button>
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
                  .map((episode) => (
                    <li key={episode.id}>
                      <button
                        onClick={() => {
                          play(
                            'series',
                            Number(episode.id),
                            `${openSeries.name} — ${episode.title}`,
                            episode.container_extension || 'mp4'
                          )
                          closeSeriesDetail()
                        }}
                      >
                        E{episode.episode_num} · {episode.title}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}
