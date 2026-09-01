import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useHlsAttach } from '../lib/useHlsAttach'
import { useResizableWidth } from '../lib/useResizableWidth'
import { useDebouncedValue } from '../lib/useDebouncedValue'
import { useNumericChannelEntry } from '../lib/useNumericChannelEntry'
import { EpgGrid } from './EpgGrid'
import type { LiveStream, ShortEpgProgram } from '../lib/types'

// Docked/full-width chrome (preview video, favorite/close buttons, resize handle) around the
// shared EpgGrid — see EpgGrid.tsx for the actual Gantt-chart guide, also reused as the
// fullscreen player's compact channel-swap overlay (PlayerChannelBar).
//
// `fullWidth`: on the Live TV tab this panel's own channel column already lists every
// channel, so there's no separate list next to it — it fills all the remaining space after
// the sidebar instead of being a fixed/resizable docked column. Movies/Series/Favorites
// still use the docked form (resizable, alongside their own ChannelList) since only a
// clicked live favorite opens it there, not a whole browsable channel column.
export function EpgGridPanel({ fullWidth = false }: { fullWidth?: boolean }): JSX.Element | null {
  const previewChannel = useAppStore((s) => s.previewChannel)
  const liveStreams = useAppStore((s) => s.liveStreams)
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const closeChannelPreview = useAppStore((s) => s.closeChannelPreview)
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const client = useAppStore((s) => s.client)
  const play = useAppStore((s) => s.play)
  const playTimeshift = useAppStore((s) => s.playTimeshift)
  const clockFormat = useAppStore((s) => s.settings.clockFormat)
  const isFavorited = useAppStore((s) => s.isFavorited)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const detailPanelWidth = useAppStore((s) => s.settings.detailPanelWidth)
  const epgRowDensity = useAppStore((s) => s.settings.epgRowDensity)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openChannelPreview = useAppStore((s) => s.openChannelPreview)
  const findChannelByNumber = useAppStore((s) => s.findChannelByNumber)
  const compact = epgRowDensity === 'compact'

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [muted, setMuted] = useState(true)
  // Set briefly (see the effect below) when a typed channel number has no match — the numeric
  // entry's own display already covers the "still typing" feedback, this covers "found nothing"
  // once it commits.
  const [numberNotFound, setNumberNotFound] = useState<number | null>(null)

  // Handle is on the panel's left edge (it's anchored to the right of the layout), so
  // dragging left should grow it — hence direction: -1. Wider bounds than the old
  // single-channel preview since a multi-channel grid genuinely benefits from more room.
  const { width, startDrag } = useResizableWidth(detailPanelWidth, -1, {
    min: 340,
    max: 1000,
    onCommit: (w) => updateSettings({ detailPanelWidth: w })
  })

  const debouncedSearch = useDebouncedValue(searchTerm, 150)
  const channels = useMemo(() => {
    if (!debouncedSearch.trim()) return liveStreams
    const needle = debouncedSearch.toLowerCase()
    return liveStreams.filter((c) => {
      if (c.name.toLowerCase().includes(needle)) return true
      // Also matches programme titles, but only for channels whose short EPG has already
      // been loaded (rows scrolled near at some point) — get_short_epg is per-channel with
      // no bulk/search endpoint, so searching every one of a 24k-channel catalog up front
      // isn't practical. Real but limited: "what's playing X right now" works for channels
      // you've already browsed past, not the whole catalog sight-unseen.
      const listings = shortEpgByStream[c.stream_id]
      return listings?.some((p) => p.title.toLowerCase().includes(needle)) ?? false
    })
  }, [liveStreams, debouncedSearch, shortEpgByStream])

  // Suppress the small preview's own stream while the fullscreen player has one open for
  // the same account — most Xtream providers cap concurrent connections quite low (often
  // just 1), so running both at once can fail outright. It resumes automatically once
  // fullscreen closes (nowPlaying clears) since previewUrl becomes non-null again.
  const previewUrl = useMemo(
    () => (client && previewChannel && !nowPlaying ? client.getStreamUrl('live', previewChannel.stream_id, 'm3u8') : null),
    [client, previewChannel, nowPlaying]
  )
  useHlsAttach(videoRef, previewUrl, muted)

  useEffect(() => {
    setMuted(true)
  }, [previewChannel?.stream_id])

  useEffect(() => {
    if (numberNotFound === null) return
    const timer = setTimeout(() => setNumberNotFound(null), 2000)
    return () => clearTimeout(timer)
  }, [numberNotFound])

  // Only active on the actual Live TV tab (fullWidth) — the docked preview panel elsewhere
  // (Movies/Series/Favorites, when a live favorite is clicked) isn't a channel-browsing surface,
  // so a typed number there would be surprising rather than useful.
  const numericEntryDisplay = useNumericChannelEntry((num) => {
    void findChannelByNumber(num).then((channel) => {
      if (channel) watchFullscreen(channel)
      else setNumberNotFound(num)
    })
  }, fullWidth)

  if (!previewChannel) {
    if (!fullWidth) return null
    return (
      <aside className="channel-detail-panel channel-detail-panel--full">
        <p className="modal-loading">Loading channels…</p>
      </aside>
    )
  }

  const favorited = isFavorited('live', previewChannel.stream_id)

  function watchFullscreen(channel: LiveStream = previewChannel!): void {
    play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon, channel.tv_archive)
    if (fullWidth) {
      // Keep the grid's state in sync (so it shows this channel highlighted/previewing
      // when fullscreen closes) rather than tearing the whole panel down — its own
      // stream is already suppressed above while nowPlaying is set, so there's no
      // concurrent-connection risk in leaving it mounted.
      if (channel.stream_id !== previewChannel!.stream_id) openChannelPreview(channel)
    } else {
      // Docked mode (Movies/Series/Favorites): the panel isn't the primary browsing
      // surface there, so just close it like before.
      closeChannelPreview()
    }
  }

  function watchFromStart(channel: LiveStream, program: ShortEpgProgram): void {
    playTimeshift(channel, program)
    closeChannelPreview()
  }

  return (
    // The resize handle lives in this non-scrolling wrapper, not inside the scrollable
    // content div — see Sidebar.tsx for why (a position:absolute child of a scrolled
    // overflow:auto element scrolls with it). In fullWidth mode there's nothing to its
    // right to resize against, so it just fills the remaining space instead.
    <aside
      className={fullWidth ? 'channel-detail-panel channel-detail-panel--full' : 'channel-detail-panel'}
      style={fullWidth ? undefined : { width }}
    >
      {!fullWidth && <div className="resize-handle resize-handle--left" onMouseDown={startDrag} />}
      {(numericEntryDisplay || numberNotFound !== null) && (
        <div className="numeric-entry-overlay">
          {numericEntryDisplay ? `Channel ${numericEntryDisplay}` : `Channel ${numberNotFound} not found`}
        </div>
      )}
      <div className="detail-panel-scroll">
        <div className="epg-panel-top">
          <div
            className="epg-preview-video-wrap"
            onClick={() => setMuted((m) => !m)}
            title={muted ? 'Click to unmute' : 'Click to mute'}
          >
            <video ref={videoRef} className="epg-preview-video" autoPlay playsInline />
            <span className="detail-preview-mute-badge">{muted ? '🔇' : '🔊'}</span>
          </div>
          <div className="epg-panel-top-info">
            <div className="epg-panel-top-heading">
              <h2>{previewChannel.name}</h2>
              <button
                className={favorited ? 'favorite-toggle active' : 'favorite-toggle'}
                onClick={() => toggleFavorite({ kind: 'live', stream: previewChannel })}
                title={favorited ? 'Remove from favorites' : 'Add to favorites'}
              >
                {favorited ? '★' : '☆'}
              </button>
              <button className="modal-close" onClick={closeChannelPreview} title="Close panel">
                ✕
              </button>
            </div>
            <button className="watch-now-button watch-now-button--compact" onClick={() => watchFullscreen()}>
              ⛶ Watch fullscreen
            </button>
          </div>
        </div>

        <EpgGrid
          channels={channels}
          activeStreamId={previewChannel.stream_id}
          clockFormat={clockFormat}
          rowHeight={compact ? 26 : 40}
          compact={compact}
          extraNavControls={
            <button
              className="epg-density-toggle"
              onClick={() => updateSettings({ epgRowDensity: compact ? 'comfortable' : 'compact' })}
              title={compact ? 'Switch to comfortable row height' : 'Switch to compact row height (shows more channels)'}
            >
              {compact ? '▤ Comfortable' : '▤ Compact'}
            </button>
          }
          onSelectChannel={openChannelPreview}
          onWatchFullscreen={watchFullscreen}
          onWatchTimeshift={watchFromStart}
        />
      </div>
    </aside>
  )
}
