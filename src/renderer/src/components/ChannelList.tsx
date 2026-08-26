import { useEffect, useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { getCurrentProgramme } from '../lib/epg'

function useFiltered<T>(items: T[], term: string, getName: (item: T) => string): T[] {
  return useMemo(() => {
    if (!term.trim()) return items
    const needle = term.toLowerCase()
    return items.filter((item) => getName(item).toLowerCase().includes(needle))
  }, [items, term, getName])
}

export function ChannelList(): JSX.Element {
  const viewMode = useAppStore((s) => s.viewMode)
  const liveStreams = useAppStore((s) => s.liveStreams)
  const vodStreams = useAppStore((s) => s.vodStreams)
  const series = useAppStore((s) => s.series)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const epg = useAppStore((s) => s.epg)
  const loadEpg = useAppStore((s) => s.loadEpg)
  const play = useAppStore((s) => s.play)
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const openSeriesDetail = useAppStore((s) => s.openSeriesDetail)

  useEffect(() => {
    if (viewMode === 'live') {
      loadEpg()
    }
  }, [viewMode, loadEpg])

  const filteredLive = useFiltered(liveStreams, searchTerm, (c) => c.name)
  const filteredVod = useFiltered(vodStreams, searchTerm, (c) => c.name)
  const filteredSeries = useFiltered(series, searchTerm, (c) => c.name)

  if (viewMode === 'live') {
    return (
      <ul className="channel-list">
        {filteredLive.map((channel) => {
          const programmes = channel.epg_channel_id
            ? epg?.programmesByChannel.get(channel.epg_channel_id)
            : undefined
          const current = getCurrentProgramme(programmes)
          const isActive = nowPlaying?.kind === 'live' && nowPlaying.streamId === channel.stream_id
          return (
            <li
              key={channel.stream_id}
              className={isActive ? 'channel-item active' : 'channel-item'}
              onClick={() => play('live', channel.stream_id, channel.name, 'm3u8')}
            >
              {channel.stream_icon ? (
                <img className="channel-icon" src={channel.stream_icon} alt="" loading="lazy" />
              ) : (
                <div className="channel-icon placeholder" />
              )}
              <div className="channel-info">
                <span className="channel-name">{channel.name}</span>
                {current && (
                  <span className="channel-epg" title={current.description}>
                    {current.title}
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  if (viewMode === 'movies') {
    return (
      <ul className="channel-list grid">
        {filteredVod.map((movie) => {
          const isActive = nowPlaying?.kind === 'movie' && nowPlaying.streamId === movie.stream_id
          return (
            <li
              key={movie.stream_id}
              className={isActive ? 'channel-item active' : 'channel-item'}
              onClick={() => play('movie', movie.stream_id, movie.name, movie.container_extension || 'mp4')}
            >
              {movie.stream_icon ? (
                <img className="channel-poster" src={movie.stream_icon} alt="" loading="lazy" />
              ) : (
                <div className="channel-poster placeholder" />
              )}
              <div className="channel-info">
                <span className="channel-name">{movie.name}</span>
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <ul className="channel-list grid">
      {filteredSeries.map((item) => (
        <li key={item.series_id} className="channel-item" onClick={() => openSeriesDetail(item)}>
          {item.cover ? (
            <img className="channel-poster" src={item.cover} alt="" loading="lazy" />
          ) : (
            <div className="channel-poster placeholder" />
          )}
          <div className="channel-info">
            <span className="channel-name">{item.name}</span>
            {item.rating && <span className="channel-epg">★ {item.rating}</span>}
          </div>
        </li>
      ))}
    </ul>
  )
}
