import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { ShortEpgProgram } from '../lib/types'

function toDate(epochSeconds: string): Date {
  return new Date(Number(epochSeconds) * 1000)
}

// start/stop_timestamp are Unix epoch seconds, so this always renders in the viewer's
// own local timezone regardless of what timezone the Xtream server itself runs in.
function formatTime(epochSeconds: string): string {
  return toDate(epochSeconds).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function progressPercent(program: ShortEpgProgram, now: number): number {
  const start = Number(program.start_timestamp) * 1000
  const stop = Number(program.stop_timestamp) * 1000
  if (stop <= start) return 0
  return Math.min(100, Math.max(0, ((now - start) / (stop - start)) * 100))
}

export function ChannelPreview(): JSX.Element | null {
  const previewChannel = useAppStore((s) => s.previewChannel)
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const closeChannelPreview = useAppStore((s) => s.closeChannelPreview)
  const play = useAppStore((s) => s.play)

  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!previewChannel) return
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [previewChannel])

  if (!previewChannel) return null

  const listings = shortEpgByStream[previewChannel.stream_id]
  const current = listings?.find((p) => Number(p.start_timestamp) * 1000 <= now && now < Number(p.stop_timestamp) * 1000)
  const upcoming = listings?.filter((p) => Number(p.start_timestamp) * 1000 > now) ?? []

  function watchNow(): void {
    if (!previewChannel) return
    play('live', previewChannel.stream_id, previewChannel.name, 'm3u8')
    closeChannelPreview()
  }

  return (
    <div className="modal-overlay" onClick={closeChannelPreview}>
      <div className="modal-card preview-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="preview-heading">
            {previewChannel.stream_icon ? (
              <img className="preview-icon" src={previewChannel.stream_icon} alt="" />
            ) : (
              <div className="preview-icon placeholder" />
            )}
            <h2>{previewChannel.name}</h2>
          </div>
          <button className="modal-close" onClick={closeChannelPreview}>
            ✕
          </button>
        </div>

        {listings === undefined && <p className="modal-loading">Loading programme guide…</p>}

        {listings?.length === 0 && (
          <p className="modal-loading">No programme guide available for this channel.</p>
        )}

        {current && (
          <div className="epg-now">
            <span className="epg-badge">On now</span>
            <h3>{current.title}</h3>
            <p className="epg-time">
              {formatTime(current.start_timestamp)} – {formatTime(current.stop_timestamp)}
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
                  <span className="epg-time">{formatTime(program.start_timestamp)}</span>
                  <span className="epg-upcoming-name">{program.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button className="watch-now-button" onClick={watchNow}>
          ▶ Watch now
        </button>
      </div>
    </div>
  )
}
