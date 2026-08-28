import { useMemo } from 'react'
import { Grid } from 'react-window'
import { useAppStore } from '../store/useAppStore'
import { useElementSize } from '../lib/useElementSize'
import { useDebouncedValue } from '../lib/useDebouncedValue'
import type { LiveStream, SeriesItem, FavoriteEntry, RecentlyWatchedEntry, MediaKind } from '../lib/types'

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

const KIND_LABEL: Record<MediaKind, string> = { live: 'Live TV', movie: 'Movie', series: 'Series' }

// Unlike favorites, a recently-watched entry is whatever was directly handed to play() — a
// flat, already-playable reference (for series, the specific episode watched, not the show) —
// so resuming it is always just play() again, with no per-kind branching needed.
function recentlyWatchedEntryToGridEntry(entry: RecentlyWatchedEntry, play: (channel: RecentlyWatchedEntry) => void): GridEntry {
  return {
    key: `recent:${entry.kind}:${entry.streamId}`,
    name: entry.name,
    image: entry.icon,
    badge: KIND_LABEL[entry.kind],
    onClick: () => play(entry)
  }
}

export function ChannelList(): JSX.Element {
  // Live TV never actually reaches this component — App.tsx renders a full-width EpgGridPanel
  // instead on that tab (its own channel column already lists every channel), so ChannelList
  // only ever handles Movies, Series, and Favorites.
  const viewMode = useAppStore((s) => s.viewMode)
  const vodStreams = useAppStore((s) => s.vodStreams)
  const series = useAppStore((s) => s.series)
  const favorites = useAppStore((s) => s.favorites)
  const recentlyWatched = useAppStore((s) => s.recentlyWatched)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const play = useAppStore((s) => s.play)
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const openSeriesDetail = useAppStore((s) => s.openSeriesDetail)
  const openChannelPreview = useAppStore((s) => s.openChannelPreview)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const isFavorited = useAppStore((s) => s.isFavorited)

  const filteredVod = useFiltered(vodStreams, searchTerm, (c) => c.name)
  const filteredSeries = useFiltered(series, searchTerm, (c) => c.name)
  const filteredFavorites = useFiltered(favorites, searchTerm, (f) =>
    f.kind === 'series' ? f.item.name : f.stream.name
  )

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

  // Favorites, with a Recently Watched strip above it — recentlyWatched is a flat, directly
  // resumable reference to whatever was last played (see recentlyWatchedEntryToGridEntry),
  // capped at 30 entries by the store, so a plain horizontal row is fine without virtualizing.
  const entries = filteredFavorites.map((f) =>
    favoriteEntryToGridEntry(f, { openChannelPreview, play, openSeriesDetail, toggleFavorite })
  )
  const resumeRecentlyWatched = (entry: RecentlyWatchedEntry): void =>
    play(entry.kind, entry.streamId, entry.name, entry.extension, entry.icon)
  const recentEntries = recentlyWatched.map((entry) => recentlyWatchedEntryToGridEntry(entry, resumeRecentlyWatched))

  return (
    <div className="virtual-list-wrap favorites-view">
      {recentEntries.length > 0 && (
        <section className="recently-watched">
          <h3 className="section-heading">Recently Watched</h3>
          <div className="recently-watched-row">
            {recentEntries.map((entry) => (
              <div
                key={entry.key}
                className="channel-item channel-item--grid recently-watched-card"
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
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="favorites-grid-wrap">
        {entries.length === 0 ? (
          <p className="empty-state">No favorites yet — click the ☆ on any channel, movie, or series to add one.</p>
        ) : (
          <MediaGrid entries={entries} />
        )}
      </div>
    </div>
  )
}
