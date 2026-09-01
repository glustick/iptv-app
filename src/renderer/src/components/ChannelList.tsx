import { useEffect, useMemo, useState } from 'react'
import { Grid, useGridRef } from 'react-window'
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

// A provider's icon/poster URL going stale (channel renamed, artwork removed) would otherwise
// show the browser's own broken-image icon indefinitely — falls back to the normal empty
// placeholder instead, same as when there was never a URL at all.
function PosterImage({ src, className }: { src: string; className: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  if (!src || broken) return <div className={`${className} placeholder`} />
  return <img className={className} src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
}

interface GridCellProps {
  entries: GridEntry[]
  columnCount: number
  focusedIndex: number
}

function GridCell({
  columnIndex,
  rowIndex,
  style,
  entries,
  columnCount,
  focusedIndex
}: { columnIndex: number; rowIndex: number; style: React.CSSProperties } & GridCellProps): JSX.Element | null {
  const index = rowIndex * columnCount + columnIndex
  const entry = entries[index]
  if (!entry) return null
  const isFocused = index === focusedIndex
  return (
    <div style={{ ...style, padding: GRID_GAP / 2 }}>
      <div
        className={`channel-item channel-item--grid${entry.active ? ' active' : ''}${isFocused ? ' channel-item--focused' : ''}`}
        onClick={entry.onClick}
      >
        <PosterImage src={entry.image} className="channel-poster" />
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
  const [focusedIndex, setFocusedIndex] = useState(0)
  const gridRef = useGridRef(null)

  // Keeps the focused cell in range as the entry list itself changes (search narrowing it, a
  // different category loading in) rather than pointing past the end.
  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(0, entries.length - 1)))
  }, [entries.length])

  function moveFocus(next: number): void {
    const clamped = Math.max(0, Math.min(entries.length - 1, next))
    setFocusedIndex(clamped)
    gridRef.current?.scrollToCell({
      rowIndex: Math.floor(clamped / columnCount),
      columnIndex: clamped % columnCount,
      rowAlign: 'smart',
      columnAlign: 'smart'
    })
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (entries.length === 0) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      moveFocus(focusedIndex + 1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      moveFocus(focusedIndex - 1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveFocus(focusedIndex + columnCount)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveFocus(focusedIndex - columnCount)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      entries[focusedIndex]?.onClick()
    }
  }

  return (
    <div
      ref={containerRef}
      className="media-grid-wrap"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{ width: '100%', height: '100%' }}
    >
      {width > 0 && height > 0 && (
        <Grid<GridCellProps>
          gridRef={gridRef}
          columnCount={columnCount}
          columnWidth={columnWidth}
          rowCount={rowCount}
          rowHeight={rowHeight}
          cellProps={{ entries, columnCount, focusedIndex }}
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
  const clearRecentlyWatched = useAppStore((s) => s.clearRecentlyWatched)
  const refreshRecentlyWatched = useAppStore((s) => s.refreshRecentlyWatched)
  const refreshingRecentlyWatched = useAppStore((s) => s.refreshingRecentlyWatched)

  const filteredVod = useFiltered(vodStreams, searchTerm, (c) => c.name)
  const filteredSeries = useFiltered(series, searchTerm, (c) => c.name)
  const filteredFavorites = useFiltered(favorites, searchTerm, (f) =>
    f.kind === 'series' ? f.item.name : f.stream.name
  )
  const filteredRecentlyWatched = useFiltered(recentlyWatched, searchTerm, (e) => e.name)

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

  if (viewMode === 'history') {
    const resumeRecentlyWatched = (entry: RecentlyWatchedEntry): void =>
      play(entry.kind, entry.streamId, entry.name, entry.extension, entry.icon, entry.tvArchive)
    const entries = filteredRecentlyWatched.map((entry) => recentlyWatchedEntryToGridEntry(entry, resumeRecentlyWatched))
    return (
      <div className="virtual-list-wrap history-view">
        <div className="history-header">
          <h3 className="section-heading">History</h3>
          {recentlyWatched.length > 0 && (
            <div className="history-header-actions">
              <button
                className="history-refresh-button"
                onClick={() => void refreshRecentlyWatched()}
                disabled={refreshingRecentlyWatched}
                title="Re-check channel/movie names and icons against the current catalog"
              >
                {refreshingRecentlyWatched ? 'Refreshing…' : 'Refresh'}
              </button>
              <button
                className="history-clear-button"
                onClick={() => {
                  if (window.confirm('Clear all watch history? This cannot be undone.')) clearRecentlyWatched()
                }}
              >
                Clear All
              </button>
            </div>
          )}
        </div>
        <div className="history-grid-wrap">
          {entries.length === 0 ? (
            <p className="empty-state">
              {recentlyWatched.length === 0
                ? 'Nothing watched yet — channels, movies, and series you play will show up here.'
                : 'No history entries match your search.'}
            </p>
          ) : (
            <MediaGrid entries={entries} />
          )}
        </div>
      </div>
    )
  }

  // Favorites.
  const entries = filteredFavorites.map((f) =>
    favoriteEntryToGridEntry(f, { openChannelPreview, play, openSeriesDetail, toggleFavorite })
  )

  return (
    <div className="virtual-list-wrap favorites-view">
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
