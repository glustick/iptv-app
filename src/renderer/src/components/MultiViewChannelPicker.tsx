import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
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
export function MultiViewChannelPicker(): JSX.Element | null {
  const pickingSlot = useAppStore((s) => s.multiViewPickingSlot)
  const liveStreams = useAppStore((s) => s.liveStreams)
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const setSearchTerm = useAppStore((s) => s.setSearchTerm)
  const categories = useAppStore((s) => s.categories)
  const selectedCategoryId = useAppStore((s) => s.selectedCategoryId)
  const requestCategory = useAppStore((s) => s.requestCategory)
  const lockedCategoryIds = useAppStore((s) => s.settings.lockedCategoryIds)
  const parentalPin = useAppStore((s) => s.settings.parentalPin)
  const unlockedCategoryIds = useAppStore((s) => s.unlockedCategoryIds)
  const clockFormat = useAppStore((s) => s.settings.clockFormat)
  const assignMultiViewChannel = useAppStore((s) => s.assignMultiViewChannel)
  const cancelPickingMultiViewSlot = useAppStore((s) => s.cancelPickingMultiViewSlot)

  const debouncedSearch = useDebouncedValue(searchTerm, 150)
  // Same derivation EpgGridPanel uses for its own channel list — kept in sync deliberately so
  // this picker's search behaves identically to browsing Live TV directly.
  const channels = useMemo(() => {
    if (!debouncedSearch.trim()) return liveStreams
    const needle = debouncedSearch.toLowerCase()
    return liveStreams.filter((c) => {
      if (c.name.toLowerCase().includes(needle)) return true
      const listings = shortEpgByStream[c.stream_id]
      return listings?.some((p) => p.title.toLowerCase().includes(needle)) ?? false
    })
  }, [liveStreams, debouncedSearch, shortEpgByStream])

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
            <select value={selectedCategoryId ?? ''} onChange={(e) => requestCategory(e.target.value || null)}>
              <option value="">All categories</option>
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
        </div>
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
