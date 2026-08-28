import { useEffect, useRef, useState, type RefObject } from 'react'

const POLL_INTERVAL_MS = 500
const LIVE_THRESHOLD_SECONDS = 5
// Matches EpgGrid's own wheel-to-time-shift scaling (see MS_PER_SCROLL_UNIT there) so scrolling
// this bar feels consistent with scrolling the EPG grid's timeline, just operating on the
// video's actual seekable range instead of a browsing window.
const SECONDS_PER_SCROLL_UNIT = 30

function formatOffset(seconds: number): string {
  const abs = Math.round(Math.abs(seconds))
  const m = Math.floor(abs / 60)
  const s = abs % 60
  return `${seconds < 0 ? '-' : ''}${m}:${String(s).padStart(2, '0')}`
}

// A slim, always-on progress bar for live playback — the DVR/seekable window native <video
// controls never show for live (see Player.tsx's controls={nowPlaying.kind !== 'live'}), so
// there's otherwise no visual sense of how far behind the live edge a rewind/skip has left you,
// or how much further back the buffer actually goes.
export function PlayerSeekBar({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }): JSX.Element | null {
  const [range, setRange] = useState<{ start: number; end: number; current: number } | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const interval = setInterval(() => {
      const video = videoRef.current
      if (!video || video.seekable.length === 0) {
        setRange(null)
        return
      }
      setRange({
        start: video.seekable.start(0),
        end: video.seekable.end(video.seekable.length - 1),
        current: video.currentTime
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [videoRef])

  if (!range || range.end <= range.start) return null

  const behindLive = range.end - range.current
  const isLive = behindLive <= LIVE_THRESHOLD_SECONDS
  const progressPct = Math.min(100, Math.max(0, ((range.current - range.start) / (range.end - range.start)) * 100))

  function seekToClientX(clientX: number): void {
    const video = videoRef.current
    const bar = barRef.current
    if (!video || !bar || !range) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    video.currentTime = range.start + pct * (range.end - range.start)
  }

  function handleWheel(e: React.WheelEvent): void {
    // Same rationale as EpgGrid's own handler: a plain vertical scroll shouldn't be hijacked
    // just because the cursor happens to be over this bar.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()
    const video = videoRef.current
    if (!video || !range) return
    const target = video.currentTime + e.deltaX * (SECONDS_PER_SCROLL_UNIT / 100)
    video.currentTime = Math.min(range.end, Math.max(range.start, target))
  }

  return (
    <div className="player-seekbar-wrap">
      <span className="player-seekbar-label">{isLive ? 'LIVE' : `-${formatOffset(behindLive).replace('-', '')}`}</span>
      <div
        ref={barRef}
        className="player-seekbar"
        onClick={(e) => seekToClientX(e.clientX)}
        onWheel={handleWheel}
        title="Click to seek, scroll horizontally to move backward/forward"
      >
        <div className="player-seekbar-track">
          <div className="player-seekbar-progress" style={{ width: `${progressPct}%` }} />
          <div className="player-seekbar-thumb" style={{ left: `${progressPct}%` }} />
        </div>
      </div>
      <span className={`player-seekbar-live-dot${isLive ? ' player-seekbar-live-dot--active' : ''}`} title={isLive ? 'At live edge' : 'Behind live'} />
    </div>
  )
}
