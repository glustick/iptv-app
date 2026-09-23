import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { kindOf } from '../lib/customCategories'
import { useDebouncedValue } from '../lib/useDebouncedValue'
import { EpgGrid } from './EpgGrid'
import type { LiveStream } from '../lib/types'

// A lightweight overlay for picking which channel goes in a Multi-View slot — reuses EpgGrid
// (the same Gantt-chart guide EpgGridPanel/PlayerChannelBar already render) rather than building
// a second channel list, since Sidebar's category selection already scopes `liveStreams` to
// whatever category is currently browsed exactly the way the Live TV tab itself works. Unlike
// EpgGridPanel, there's no preview video or favorite toggle here — picking a slot's channel is
// the only thing this surface is for, so a single click is enough to choose one and close.
//
// The category dropdown and search box below are this modal's OWN controls, not just a comment
// pointing at Sidebar/TopBar's — reported directly as a real usability gap: `.modal-overlay` is
// a fixed, full-viewport layer (see global.css), so it visually and functionally covers both of
// those the moment this picker opens. The underlying scoping (`liveStreams` already filtered by
// `selectedCategoryId`, `searchTerm` already wired to the same store fields Live TV itself uses)
// was correct from the start; there was just no reachable way to change either one while the
// picker was open, which on a large real catalog (tens of thousands of channels across hundreds
// of categories) meant scrolling through everything with no way to narrow it down.
//
// Reworked in 0.7.104 after the same surface was reported unusable at catalogue scale: it opened
// on whatever the sidebar was showing — "All" by default, i.e. a few thousand rows — and only then
// offered a way to narrow down, so picking a channel meant waiting for a bulk load first. The
// requested shape was explicit: "just showing the favourites list first, then prepopulating the
// category selection". So the picker now **opens on favourites** (which carry their own channel
// objects — no catalogue load, nothing to wait for) and the category list below is populated from
// the categories the sidebar has already loaded, with "All categories" available but no longer the
// default. Choosing a category still drives the shared browsing scope, deliberately: the grid
// behind this modal then matches what was picked.
export function MultiViewChannelPicker(): JSX.Element | null {
  const pickingSlot = useAppStore((s) => s.multiViewPickingSlot)
  const liveStreams = useAppStore((s) => s.liveStreams)
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const setSearchTerm = useAppStore((s) => s.setSearchTerm)
  const categories = useAppStore((s) => s.categories)
  const selectedCategoryId = useAppStore((s) => s.selectedCategoryId)
  const requestCategory = useAppStore((s) => s.requestCategory)
  const customCategories = useAppStore((s) => s.settings.customCategories)
  const selectedCustomCategoryId = useAppStore((s) => s.selectedCustomCategoryId)
  const requestCustomCategory = useAppStore((s) => s.requestCustomCategory)
  const lockedCategoryIds = useAppStore((s) => s.settings.lockedCategoryIds)
  const parentalPin = useAppStore((s) => s.settings.parentalPin)
  const unlockedCategoryIds = useAppStore((s) => s.unlockedCategoryIds)
  const clockFormat = useAppStore((s) => s.settings.clockFormat)
  const assignMultiViewChannel = useAppStore((s) => s.assignMultiViewChannel)
  const cancelPickingMultiViewSlot = useAppStore((s) => s.cancelPickingMultiViewSlot)
  const hiddenLiveStreamIds = useAppStore((s) => s.settings.hiddenLiveStreamIds)
  const showHiddenLiveChannels = useAppStore((s) => s.showHiddenLiveChannels)
  const setShowHiddenLiveChannels = useAppStore((s) => s.setShowHiddenLiveChannels)

  const favorites = useAppStore((s) => s.favorites)

  // What the picker is showing: the user's own favourites (the default, and cheap — each entry
  // carries its channel), or a category they explicitly chose.
  const [scope, setScope] = useState<'favorites' | 'category'>('favorites')
  useEffect(() => {
    // Re-open on favourites every time, so opening a slot never inherits a bulk category from the
    // last session — the whole point of the rework.
    if (pickingSlot !== null) setScope('favorites')
  }, [pickingSlot])

  const favoriteChannels = useMemo(() => {
    const live = favorites.filter((entry) => entry.kind === 'live').map((entry) => entry.stream)
    return showHiddenLiveChannels ? live : live.filter((c) => !hiddenLiveStreamIds.includes(c.stream_id))
  }, [favorites, hiddenLiveStreamIds, showHiddenLiveChannels])

  const debouncedSearch = useDebouncedValue(searchTerm, 150)
  // Same derivation EpgGridPanel uses for its own channel list — kept in sync deliberately so
  // this picker's search behaves identically to browsing Live TV directly.
  const channels = useMemo(() => {
    const source =
      scope === 'favorites'
        ? favoriteChannels
        : showHiddenLiveChannels
          ? liveStreams
          : liveStreams.filter((c) => !hiddenLiveStreamIds.includes(c.stream_id))
    if (!debouncedSearch.trim()) return source
    const needle = debouncedSearch.toLowerCase()
    return source.filter((c) => {
      if (c.name.toLowerCase().includes(needle)) return true
      const listings = shortEpgByStream[c.stream_id]
      return listings?.some((p) => p.title.toLowerCase().includes(needle)) ?? false
    })
  }, [scope, favoriteChannels, liveStreams, debouncedSearch, shortEpgByStream, hiddenLiveStreamIds, showHiddenLiveChannels])

  if (pickingSlot === null) return null

  function pick(channel: LiveStream): void {
    assignMultiViewChannel(pickingSlot!, channel)
  }

  // Same namespacing convention requestCategory itself already applies internally for
  // Multi-View (see that action) — mirrored here just to render the 🔒 badge on the right
  // categories, not to re-decide locking (requestCategory still owns that decision).
  const isLocked = (categoryId: string): boolean => {
    const lockKey = `live:${categoryId}`
    return !!parentalPin && lockedCategoryIds.includes(lockKey) && !unlockedCategoryIds.includes(lockKey)
  }

  return (
    <div className="modal-overlay" onClick={cancelPickingMultiViewSlot}>
      <div className="modal-card multiview-picker-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Choose a channel for Screen {pickingSlot + 1}</h2>
          <button className="modal-close" onClick={cancelPickingMultiViewSlot} title="Cancel">
            ✕
          </button>
        </div>
        <div className="multiview-picker-filters">
          <label className="player-track-select" title="Category">
            <span aria-hidden="true">📂</span>
            <select
              value={
                scope === 'favorites'
                  ? 'favorites'
                  : selectedCustomCategoryId
                    ? `custom:${selectedCustomCategoryId}`
                    : (selectedCategoryId ?? '')
              }
              onChange={(e) => {
                const value = e.target.value
                if (value === 'favorites') {
                  setScope('favorites')
                  return
                }
                setScope('category')
                // Custom categories are a different selection domain (and a different store
                // action) — namespaced in the option value so both can live in one select.
                if (value.startsWith('custom:')) requestCustomCategory(value.slice('custom:'.length))
                else requestCategory(value || null)
              }}
            >
              <option value="favorites">★ Favourites ({favoriteChannels.length})</option>
              <option value="">All categories</option>
              {/* The user's own groupings first, mirroring the sidebar's own ordering. */}
              {customCategories.some((cat) => kindOf(cat) === 'live') && (
                <optgroup label="My Categories">
                  {customCategories.filter((cat) => kindOf(cat) === 'live').map((cat) => (
                    <option key={cat.id} value={`custom:${cat.id}`}>
                      {cat.name} ({cat.streamIds.length})
                    </option>
                  ))}
                </optgroup>
              )}
              {categories.map((cat) => (
                <option key={cat.category_id} value={cat.category_id}>
                  {isLocked(cat.category_id) ? `🔒 ${cat.category_name}` : cat.category_name}
                </option>
              ))}
            </select>
          </label>
          <input
            className="search-input multiview-picker-search"
            placeholder="Search channels…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {hiddenLiveStreamIds.length > 0 && (
            <button className="epg-density-toggle" onClick={() => setShowHiddenLiveChannels(!showHiddenLiveChannels)}>
              {showHiddenLiveChannels ? 'Hide hidden' : `Show hidden (${hiddenLiveStreamIds.length})`}
            </button>
          )}
        </div>
        {scope === 'favorites' && favoriteChannels.length === 0 ? (
          // An empty state that says what to do, rather than an empty grid: the picker now opens
          // here, so "no favourites yet" has to be a useful screen in its own right.
          <p className="multiview-picker-empty">
            No favourite channels yet — pick a category above to browse, or star channels on the Live TV
            tab and they will appear here.
          </p>
        ) : null}
        <EpgGrid
          channels={channels}
          clockFormat={clockFormat}
          rowHeight={32}
          compact
          onSelectChannel={pick}
          onWatchFullscreen={pick}
          onWatchTimeshift={pick}
        />
      </div>
    </div>
  )
}
