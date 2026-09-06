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
export function MultiViewChannelPicker(): JSX.Element | null {
  const pickingSlot = useAppStore((s) => s.multiViewPickingSlot)
  const liveStreams = useAppStore((s) => s.liveStreams)
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const searchTerm = useAppStore((s) => s.searchTerm)
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

  return (
    <div className="modal-overlay" onClick={cancelPickingMultiViewSlot}>
      <div className="modal-card multiview-picker-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Choose a channel for Screen {pickingSlot + 1}</h2>
          <button className="modal-close" onClick={cancelPickingMultiViewSlot} title="Cancel">
            ✕
          </button>
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
