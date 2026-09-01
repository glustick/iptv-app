import { useEffect, useMemo, useState } from 'react'
import { Grid, useGridRef } from 'react-window'
import { useAppStore } from '../store/useAppStore'
import { useElementSize } from '../lib/useElementSize'
import { useDebouncedValue } from '../lib/useDebouncedValue'
import type { LiveStream, SeriesItem, FavoriteEntry, FavoriteGroup, RecentlyWatchedEntry, MediaKind } from '../lib/types'
import { favoriteKey } from '../lib/types'

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
  // Only ever set on the Favorites tab — lets a tile assign itself directly to a group without
  // leaving the grid (a native <select>, not a custom dropdown, since this is exactly the kind
  // of small, infrequent picker native form controls already handle well).
  groupSelect?: { currentGroupId: string | null; groups: FavoriteGroup[]; onChange: (groupId: string | null) => void }
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
        {entry.groupSelect && (
          <select
            className="favorite-group-select"
            value={entry.groupSelect.currentGroupId ?? ''}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => entry.groupSelect?.onChange(e.target.value || null)}
            title="Move to group"
          >
            <option value="">Ungrouped</option>
            {entry.groupSelect.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
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
    favoriteGroups: FavoriteGroup[]
    setFavoriteGroup: (key: string, groupId: string | null) => void
  }
): GridEntry {
  const key = favoriteKey(entry)
  const groupSelect = {
    currentGroupId: entry.groupId ?? null,
    groups: handlers.favoriteGroups,
    onChange: (groupId: string | null) => handlers.setFavoriteGroup(key, groupId)
  }
  if (entry.kind === 'live') {
    return {
      key: `live:${entry.stream.stream_id}`,
      name: entry.stream.name,
      image: entry.stream.stream_icon,
      badge: 'Live TV',
      onClick: () => handlers.openChannelPreview(entry.stream),
      favorite: { active: true, onToggle: () => handlers.toggleFavorite(entry) },
      groupSelect
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
      favorite: { active: true, onToggle: () => handlers.toggleFavorite(entry) },
      groupSelect
    }
  }
  return {
    key: `series:${entry.item.series_id}`,
    name: entry.item.name,
    image: entry.item.cover,
    badge: 'Series',
    onClick: () => handlers.openSeriesDetail(entry.item),
    favorite: { active: true, onToggle: () => handlers.toggleFavorite(entry) },
    groupSelect
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
  const favoriteGroups = useAppStore((s) => s.favoriteGroups)
  const recentlyWatched = useAppStore((s) => s.recentlyWatched)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const play = useAppStore((s) => s.play)
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const openSeriesDetail = useAppStore((s) => s.openSeriesDetail)
  const openChannelPreview = useAppStore((s) => s.openChannelPreview)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const isFavorited = useAppStore((s) => s.isFavorited)
  const setFavoriteGroup = useAppStore((s) => s.setFavoriteGroup)
  const addFavoriteGroup = useAppStore((s) => s.addFavoriteGroup)
  const renameFavoriteGroup = useAppStore((s) => s.renameFavoriteGroup)
  const deleteFavoriteGroup = useAppStore((s) => s.deleteFavoriteGroup)
  const clearRecentlyWatched = useAppStore((s) => s.clearRecentlyWatched)
  const refreshRecentlyWatched = useAppStore((s) => s.refreshRecentlyWatched)
  const refreshingRecentlyWatched = useAppStore((s) => s.refreshingRecentlyWatched)
  // 'all' (default) shows every favorite; a specific group id scopes the grid to just that
  // group's members; null scopes to favorites with no group assigned at all. Local, view-only
  // state — deliberately not persisted, the same way a search term or focused grid cell isn't.
  const [selectedGroupId, setSelectedGroupId] = useState<string | null | 'all'>('all')
  // Both null when their inline form isn't open — Electron has no window.prompt() at all
  // (confirmed live: it throws "prompt() is and will not be supported," unlike window.confirm(),
  // which does work and is still used for the destructive delete-group case below), so creating
  // and renaming a group need a real inline text input instead.
  const [newGroupName, setNewGroupName] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState<string | null>(null)

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

  // Favorites, optionally scoped to one named group — 'all' (the default) shows everything,
  // null scopes to favorites with no group assigned, a group id scopes to just that group.
  const groupFilteredFavorites =
    selectedGroupId === 'all' ? filteredFavorites : filteredFavorites.filter((f) => (f.groupId ?? null) === selectedGroupId)
  const entries = groupFilteredFavorites.map((f) =>
    favoriteEntryToGridEntry(f, { openChannelPreview, play, openSeriesDetail, toggleFavorite, favoriteGroups, setFavoriteGroup })
  )
  const selectedGroup = typeof selectedGroupId === 'string' ? favoriteGroups.find((g) => g.id === selectedGroupId) : undefined

  function commitAddGroup(): void {
    if (newGroupName?.trim()) addFavoriteGroup(newGroupName)
    setNewGroupName(null)
  }

  function commitRenameGroup(group: FavoriteGroup): void {
    if (renameDraft?.trim()) renameFavoriteGroup(group.id, renameDraft)
    setRenameDraft(null)
  }

  function handleDeleteGroup(group: FavoriteGroup): void {
    if (window.confirm(`Delete "${group.name}"? Favorites in it become ungrouped, not deleted.`)) {
      deleteFavoriteGroup(group.id)
      setSelectedGroupId('all')
    }
  }

  return (
    <div className="virtual-list-wrap favorites-view">
      {favorites.length > 0 && (
        <div className="favorite-group-tabs">
          <button
            className={selectedGroupId === 'all' ? 'favorite-group-tab active' : 'favorite-group-tab'}
            onClick={() => setSelectedGroupId('all')}
          >
            All
          </button>
          <button
            className={selectedGroupId === null ? 'favorite-group-tab active' : 'favorite-group-tab'}
            onClick={() => setSelectedGroupId(null)}
          >
            Ungrouped
          </button>
          {favoriteGroups.map((g) =>
            selectedGroupId === g.id && renameDraft !== null ? (
              <span key={g.id} className="favorite-group-inline-form">
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRenameGroup(g)
                    if (e.key === 'Escape') setRenameDraft(null)
                  }}
                />
                <button onClick={() => commitRenameGroup(g)}>Save</button>
                <button onClick={() => setRenameDraft(null)}>Cancel</button>
              </span>
            ) : (
              <button
                key={g.id}
                className={selectedGroupId === g.id ? 'favorite-group-tab active' : 'favorite-group-tab'}
                onClick={() => setSelectedGroupId(g.id)}
              >
                {g.name}
              </button>
            )
          )}
          {newGroupName !== null ? (
            <span className="favorite-group-inline-form">
              <input
                autoFocus
                value={newGroupName}
                placeholder="Group name"
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitAddGroup()
                  if (e.key === 'Escape') setNewGroupName(null)
                }}
              />
              <button onClick={commitAddGroup}>Add</button>
              <button onClick={() => setNewGroupName(null)}>Cancel</button>
            </span>
          ) : (
            <button className="favorite-group-add" onClick={() => setNewGroupName('')}>
              + New Group
            </button>
          )}
          {selectedGroup && renameDraft === null && (
            <span className="favorite-group-manage">
              <button
                className="favorite-group-manage-btn"
                onClick={() => setRenameDraft(selectedGroup.name)}
              >
                Rename
              </button>
              <button className="favorite-group-manage-btn" onClick={() => handleDeleteGroup(selectedGroup)}>
                Delete
              </button>
            </span>
          )}
        </div>
      )}
      <div className="favorites-grid-wrap">
        {entries.length === 0 ? (
          <p className="empty-state">
            {favorites.length === 0
              ? 'No favorites yet — click the ☆ on any channel, movie, or series to add one.'
              : 'No favorites in this group match your search.'}
          </p>
        ) : (
          <MediaGrid entries={entries} />
        )}
      </div>
    </div>
  )
}
