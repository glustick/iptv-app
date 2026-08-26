import { useEffect, useMemo } from 'react'
import { List, Grid } from 'react-window'
import { useAppStore } from '../store/useAppStore'
import { getCurrentProgramme, type EpgData } from '../lib/epg'
import { useElementSize } from '../lib/useElementSize'
import { useDebouncedValue } from '../lib/useDebouncedValue'
import type { LiveStream, SeriesItem, FavoriteEntry } from '../lib/types'

const ROW_HEIGHT = 62
const GRID_CELL_MIN_WIDTH = 150
const GRID_GAP = 14

function useFiltered<T>(items: T[], term: string, getName: (item: T) => string): T[] {
  const debouncedTerm = useDebouncedValue(term, 150)
  return useMemo(() => {
    if (!debouncedTerm.trim()) return items
    const needle = debouncedTerm.toLowerCase()
    return items.filter((item) => getName(item).toLowerCase().includes(needle))
  }, [items, debouncedTerm, getName])
}

interface LiveRowProps {
  items: LiveStream[]
  epg: EpgData | null
  activeStreamId?: number
  onOpen: (channel: LiveStream) => void
  isFavorited: (id: number) => boolean
  onToggleFavorite: (channel: LiveStream) => void
}

function LiveRow({
  index,
  style,
  items,
  epg,
  activeStreamId,
  onOpen,
  isFavorited,
  onToggleFavorite
}: { index: number; style: React.CSSProperties } & LiveRowProps): JSX.Element {
  const channel = items[index]
  const programmes = channel.epg_channel_id ? epg?.programmesByChannel.get(channel.epg_channel_id) : undefined
  const current = getCurrentProgramme(programmes)
  const isActive = activeStreamId === channel.stream_id
  const favorited = isFavorited(channel.stream_id)

  return (
    <div style={style}>
      <div
        className={isActive ? 'channel-item channel-item--row active' : 'channel-item channel-item--row'}
        onClick={() => onOpen(channel)}
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
        <button
          className={favorited ? 'favorite-toggle active' : 'favorite-toggle'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite(channel)
          }}
          title={favorited ? 'Remove from favorites' : 'Add to favorites'}
        >
          {favorited ? '★' : '☆'}
        </button>
      </div>
    </div>
  )
}

export interface GridEntry {
  key: string
  name: string
  image: string
  badge?: string
  active?: boolean
  onClick: () => void
  favorite?: { active: boolean; onToggle: () => void }
}

interface GridCellProps {
  entries: GridEntry[]
  columnCount: number
}

function GridCell({
  columnIndex,
  rowIndex,
  style,
  entries,
  columnCount
}: { columnIndex: number; rowIndex: number; style: React.CSSProperties } & GridCellProps): JSX.Element | null {
  const index = rowIndex * columnCount + columnIndex
  const entry = entries[index]
  if (!entry) return null
  return (
    <div style={{ ...style, padding: GRID_GAP / 2 }}>
      <div
        className={entry.active ? 'channel-item channel-item--grid active' : 'channel-item channel-item--grid'}
        onClick={entry.onClick}
      >
        {entry.image ? (
          <img className="channel-poster" src={entry.image} alt="" loading="lazy" />
        ) : (
          <div className="channel-poster placeholder" />
        )}
        <div className="channel-info">
          <span className="channel-name">{entry.name}</span>
          {entry.badge && <span className="channel-epg">{entry.badge}</span>}
        </div>
        {entry.favorite && (
          <button
            className={entry.favorite.active ? 'favorite-toggle active' : 'favorite-toggle'}
            onClick={(e) => {
              e.stopPropagation()
              entry.favorite?.onToggle()
            }}
            title={entry.favorite.active ? 'Remove from favorites' : 'Add to favorites'}
          >
            {entry.favorite.active ? '★' : '☆'}
          </button>
        )}
      </div>
    </div>
  )
}

function MediaGrid({ entries }: { entries: GridEntry[] }): JSX.Element {
  const [containerRef, { width, height }] = useElementSize<HTMLDivElement>()
  const columnCount = Math.max(1, Math.floor((width + GRID_GAP) / (GRID_CELL_MIN_WIDTH + GRID_GAP)))
  const columnWidth = width > 0 ? width / columnCount : GRID_CELL_MIN_WIDTH
  const rowHeight = columnWidth * 1.5 + 48
  const rowCount = Math.ceil(entries.length / columnCount)

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      {width > 0 && height > 0 && (
        <Grid<GridCellProps>
          columnCount={columnCount}
          columnWidth={columnWidth}
          rowCount={rowCount}
          rowHeight={rowHeight}
          cellProps={{ entries, columnCount }}
          style={{ height: '100%', width: '100%' }}
          cellComponent={GridCell}
        />
      )}
    </div>
  )
}

function favoriteEntryToGridEntry(
  entry: FavoriteEntry,
  handlers: {
    openChannelPreview: (c: LiveStream) => void
    play: (kind: 'movie', id: number, name: string, ext: string, icon?: string) => void
    openSeriesDetail: (item: SeriesItem) => void
    toggleFavorite: (entry: FavoriteEntry) => void
  }
): GridEntry {
  if (entry.kind === 'live') {
    return {
      key: `live:${entry.stream.stream_id}`,
      name: entry.stream.name,
      image: entry.stream.stream_icon,
      badge: 'Live TV',
      onClick: () => handlers.openChannelPreview(entry.stream),
      favorite: { active: true, onToggle: () => handlers.toggleFavorite(entry) }
    }
  }
  if (entry.kind === 'movie') {
    return {
      key: `movie:${entry.stream.stream_id}`,
      name: entry.stream.name,
      image: entry.stream.stream_icon,
      badge: 'Movie',
      onClick: () =>
        handlers.play('movie', entry.stream.stream_id, entry.stream.name, entry.stream.container_extension || 'mp4'),
      favorite: { active: true, onToggle: () => handlers.toggleFavorite(entry) }
    }
  }
  return {
    key: `series:${entry.item.series_id}`,
    name: entry.item.name,
    image: entry.item.cover,
    badge: 'Series',
    onClick: () => handlers.openSeriesDetail(entry.item),
    favorite: { active: true, onToggle: () => handlers.toggleFavorite(entry) }
  }
}

export function ChannelList(): JSX.Element {
  const viewMode = useAppStore((s) => s.viewMode)
  const liveStreams = useAppStore((s) => s.liveStreams)
  const vodStreams = useAppStore((s) => s.vodStreams)
  const series = useAppStore((s) => s.series)
  const favorites = useAppStore((s) => s.favorites)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const epg = useAppStore((s) => s.epg)
  const loadEpg = useAppStore((s) => s.loadEpg)
  const play = useAppStore((s) => s.play)
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const openSeriesDetail = useAppStore((s) => s.openSeriesDetail)
  const openChannelPreview = useAppStore((s) => s.openChannelPreview)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const isFavorited = useAppStore((s) => s.isFavorited)

  useEffect(() => {
    if (viewMode === 'live') {
      loadEpg()
    }
  }, [viewMode, loadEpg])

  const filteredLive = useFiltered(liveStreams, searchTerm, (c) => c.name)
  const filteredVod = useFiltered(vodStreams, searchTerm, (c) => c.name)
  const filteredSeries = useFiltered(series, searchTerm, (c) => c.name)
  const filteredFavorites = useFiltered(favorites, searchTerm, (f) =>
    f.kind === 'series' ? f.item.name : f.stream.name
  )

  if (viewMode === 'live') {
    if (filteredLive.length === 0) return <p className="empty-state">No channels in this category.</p>
    return (
      <div className="virtual-list-wrap">
        <List<LiveRowProps>
          rowCount={filteredLive.length}
          rowHeight={ROW_HEIGHT}
          rowProps={{
            items: filteredLive,
            epg,
            activeStreamId: nowPlaying?.kind === 'live' ? nowPlaying.streamId : undefined,
            onOpen: openChannelPreview,
            isFavorited: (id: number) => isFavorited('live', id),
            onToggleFavorite: (channel: LiveStream) => toggleFavorite({ kind: 'live', stream: channel })
          }}
          rowComponent={LiveRow}
          style={{ height: '100%', width: '100%' }}
        />
      </div>
    )
  }

  if (viewMode === 'movies') {
    const entries: GridEntry[] = filteredVod.map((movie) => ({
      key: `movie:${movie.stream_id}`,
      name: movie.name,
      image: movie.stream_icon,
      active: nowPlaying?.kind === 'movie' && nowPlaying.streamId === movie.stream_id,
      onClick: () => play('movie', movie.stream_id, movie.name, movie.container_extension || 'mp4', movie.stream_icon),
      favorite: {
        active: isFavorited('movie', movie.stream_id),
        onToggle: () => toggleFavorite({ kind: 'movie', stream: movie })
      }
    }))
    if (entries.length === 0) return <p className="empty-state">No movies in this category.</p>
    return (
      <div className="virtual-list-wrap">
        <MediaGrid entries={entries} />
      </div>
    )
  }

  if (viewMode === 'series') {
    const entries: GridEntry[] = filteredSeries.map((item) => ({
      key: `series:${item.series_id}`,
      name: item.name,
      image: item.cover,
      badge: item.rating ? `★ ${item.rating}` : undefined,
      onClick: () => openSeriesDetail(item),
      favorite: {
        active: isFavorited('series', item.series_id),
        onToggle: () => toggleFavorite({ kind: 'series', item })
      }
    }))
    if (entries.length === 0) return <p className="empty-state">No series in this category.</p>
    return (
      <div className="virtual-list-wrap">
        <MediaGrid entries={entries} />
      </div>
    )
  }

  // Favorites
  const entries = filteredFavorites.map((f) =>
    favoriteEntryToGridEntry(f, { openChannelPreview, play, openSeriesDetail, toggleFavorite })
  )
  if (entries.length === 0) {
    return <p className="empty-state">No favorites yet — click the ☆ on any channel, movie, or series to add one.</p>
  }
  return (
    <div className="virtual-list-wrap">
      <MediaGrid entries={entries} />
    </div>
  )
}
