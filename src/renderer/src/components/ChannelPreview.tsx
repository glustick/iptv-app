import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useHlsAttach } from '../lib/useHlsAttach'
import { useResizableWidth } from '../lib/useResizableWidth'
import type { ShortEpgProgram, ClockFormat } from '../lib/types'

function toDate(epochSeconds: string): Date {
  return new Date(Number(epochSeconds) * 1000)
}

// start/stop_timestamp are Unix epoch seconds, so this always renders in the viewer's
// own local timezone regardless of what timezone the Xtream server itself runs in.
function formatTime(epochSeconds: string, clockFormat: ClockFormat): string {
  return toDate(epochSeconds).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: clockFormat === '12h' })
}

function progressPercent(program: ShortEpgProgram, now: number): number {
  const start = Number(program.start_timestamp) * 1000
  const stop = Number(program.stop_timestamp) * 1000
  if (stop <= start) return 0
  return Math.min(100, Math.max(0, ((now - start) / (stop - start)) * 100))
}

// This is the docked detail panel shown to the right of the channel list when a live
// channel is clicked — a small muted video preview plus that channel's EPG. It's
// deliberately not a modal: browsing the rest of the list stays available underneath it.
export function ChannelPreview(): JSX.Element | null {
  const previewChannel = useAppStore((s) => s.previewChannel)
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const closeChannelPreview = useAppStore((s) => s.closeChannelPreview)
  const client = useAppStore((s) => s.client)
  const play = useAppStore((s) => s.play)
  const playTimeshift = useAppStore((s) => s.playTimeshift)
  const clockFormat = useAppStore((s) => s.settings.clockFormat)
  const isFavorited = useAppStore((s) => s.isFavorited)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const detailPanelWidth = useAppStore((s) => s.settings.detailPanelWidth)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [muted, setMuted] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  // Handle is on the panel's left edge (it's anchored to the right of the layout), so
  // dragging left should grow it — hence direction: -1.
  const { width, startDrag } = useResizableWidth(detailPanelWidth, -1, {
    min: 300,
    max: 560,
    onCommit: (w) => updateSettings({ detailPanelWidth: w })
  })

  const previewUrl = useMemo(
    () => (client && previewChannel ? client.getStreamUrl('live', previewChannel.stream_id, 'm3u8') : null),
    [client, previewChannel]
  )
  useHlsAttach(videoRef, previewUrl, muted)

  useEffect(() => {
    if (!previewChannel) return
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [previewChannel])

  // Reset the mute state each time a different channel is selected, rather than carrying
  // an unmute choice over to the next channel silently.
  useEffect(() => {
    setMuted(true)
  }, [previewChannel?.stream_id])

  if (!previewChannel) return null

  const listings = shortEpgByStream[previewChannel.stream_id]
  const current = listings?.find((p) => Number(p.start_timestamp) * 1000 <= now && now < Number(p.stop_timestamp) * 1000)
  const upcoming = listings?.filter((p) => Number(p.start_timestamp) * 1000 > now) ?? []
  const past = listings?.filter((p) => Number(p.stop_timestamp) * 1000 <= now) ?? []
  const canCatchUp = previewChannel.tv_archive === 1 && past.length > 0
  const favorited = isFavorited('live', previewChannel.stream_id)

  function watchFullscreen(): void {
    if (!previewChannel) return
    // Closing the preview stops its own stream connection before the fullscreen player
    // opens its own — most Xtream accounts cap concurrent connections quite low (often
    // just 1), so two simultaneous streams to the same account can fail outright.
    play('live', previewChannel.stream_id, previewChannel.name, 'm3u8', previewChannel.stream_icon)
    closeChannelPreview()
  }

  function watchFromStart(program: ShortEpgProgram): void {
    if (!previewChannel) return
    playTimeshift(previewChannel, program)
    closeChannelPreview()
  }

  return (
    // The resize handle lives in this non-scrolling wrapper, not inside the scrollable
    // content div — a position:absolute child of a scrolled overflow:auto element scrolls
    // with it, which would carry the handle out of view once the EPG list is tall enough
    // to scroll.
    <aside className="channel-detail-panel" style={{ width }}>
      <div className="resize-handle resize-handle--left" onMouseDown={startDrag} />
      <div className="detail-panel-scroll">
      <div className="detail-panel-header">
        <div className="preview-heading">
          {previewChannel.stream_icon ? (
            <img className="preview-icon" src={previewChannel.stream_icon} alt="" />
          ) : (
            <div className="preview-icon placeholder" />
          )}
          <h2>{previewChannel.name}</h2>
        </div>
        <div className="preview-header-actions">
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
      </div>

      <div className="detail-preview-video-wrap" onClick={() => setMuted((m) => !m)} title={muted ? 'Click to unmute' : 'Click to mute'}>
        <video ref={videoRef} className="detail-preview-video" autoPlay playsInline />
        <span className="detail-preview-mute-badge">{muted ? '🔇' : '🔊'}</span>
      </div>

      <button className="watch-now-button" onClick={watchFullscreen}>
        ⛶ Watch fullscreen
      </button>

      <div className="detail-epg">
        {listings === undefined && <p className="modal-loading">Loading programme guide…</p>}

        {listings?.length === 0 && <p className="modal-loading">No programme guide available for this channel.</p>}

        {current && (
          <div className="epg-now">
            <span className="epg-badge">On now</span>
            <h3>{current.title}</h3>
            <p className="epg-time">
              {formatTime(current.start_timestamp, clockFormat)} – {formatTime(current.stop_timestamp, clockFormat)}
            </p>
            {current.description && <p className="epg-description">{current.description}</p>}
            <div className="epg-progress">
              <div className="epg-progress-fill" style={{ width: `${progressPercent(current, now)}%` }} />
            </div>
          </div>
        )}

        {upcoming.length > 0 && (
          <div className="epg-upcoming">
            <h3 className="epg-upcoming-title">Coming up</h3>
            <ul>
              {upcoming.map((program, index) => (
                <li key={`${program.id}-${index}`}>
                  <span className="epg-time">{formatTime(program.start_timestamp, clockFormat)}</span>
                  <span className="epg-upcoming-name">{program.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {canCatchUp && (
          <div className="epg-upcoming">
            <h3 className="epg-upcoming-title">Catch up</h3>
            <ul>
              {past.map((program, index) => (
                <li key={`${program.id}-past-${index}`}>
                  <span className="epg-time">{formatTime(program.start_timestamp, clockFormat)}</span>
                  <span className="epg-upcoming-name">{program.title}</span>
                  <button className="catch-up-button" onClick={() => watchFromStart(program)}>
                    ▶ Watch
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      </div>
    </aside>
  )
}
