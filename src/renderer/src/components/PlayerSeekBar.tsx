import { useEffect, useRef, useState, type RefObject } from 'react'
import { buildCatchupTimeline, windowExtentLabel } from '../lib/catchupTimeline'
import { formatProgrammeTime } from '../lib/programmeDetail'
import type { ClockFormat, ShortEpgProgram } from '../lib/types'

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

/** What PlayerSeekBar needs to draw the catch-up timeline (0.47.0) over the plain bar. Null
 *  whenever the feature is honestly unavailable — an M3U profile (getTimeshiftUrl throws and
 *  no short EPG is ever fetched), a channel without the archive flag, or an archive whose
 *  provider gave no window length (tv_archive_duration 0) — and the plain bar then renders
 *  with nothing added, not even empty chrome. */
export interface PlayerSeekBarCatchup {
  programmes: ShortEpgProgram[]
  archiveHours: number
  clockFormat: ClockFormat
}

// A slim, always-on progress bar for live playback — the DVR/seekable window native <video
// controls never show for live (see Player.tsx's controls={nowPlaying.kind !== 'live'}), so
// there's otherwise no visual sense of how far behind the live edge a rewind/skip has left you,
// or how much further back the buffer actually goes.
//
// 0.47.0 adds the catch-up timeline: when the playing channel carries a real archive
// (Player passes the archive flag, its window length and this channel's short EPG), a marker
// strip above the track shows which programme occupies which slice of the buffer, with the
// programme containing right now highlighted — so a rewound stream says what you landed on,
// not just how far back you are. The markers compute from the SAME poll tick and the SAME
// video.seekable the bar already reads; the epoch mapping that joins programme timestamps to
// that media-second range is documented in lib/catchupTimeline.ts (anchor the window's end at
// now — the live edge — and span it backwards across its own duration).
export function PlayerSeekBar({
  videoRef,
  catchup = null
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  catchup?: PlayerSeekBarCatchup | null
}): JSX.Element | null {
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

  // The catch-up timeline, recomputed per poll tick like the bar itself: the media-second
  // seekable window maps onto epoch ms with its end anchored at now (the live edge — the same
  // identity goToLive relies on), programmes clip onto that span, and the label says how far
  // behind live the window actually reaches. With no markers (listings absent, or none overlap
  // this buffer) the strip renders nothing rather than empty chrome.
  let markers: ReturnType<typeof buildCatchupTimeline> = []
  let extentLabel: string | null = null
  if (catchup && catchup.archiveHours > 0 && catchup.programmes.length > 0) {
    const now = Date.now()
    const seekableWindow = { startMs: now - (range.end - range.start) * 1000, endMs: now }
    markers = buildCatchupTimeline(seekableWindow, catchup.programmes, now)
    extentLabel = windowExtentLabel(seekableWindow, now)
  }

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
      <div className="player-seekbar-column">
        {markers.length > 0 && (
          <div className="player-seekbar-markers" title="Catch-up window — programmes still in the buffer">
            {markers.map((marker, index) => (
              <div
                key={index}
                className={`player-seekbar-marker${marker.isCurrent ? ' player-seekbar-marker--current' : ''}`}
                style={{
                  left: `${marker.startFraction * 100}%`,
                  width: `${(marker.endFraction - marker.startFraction) * 100}%`
                }}
                title={`${marker.title} — ${formatProgrammeTime(String(Math.round(marker.startMs / 1000)), catchup!.clockFormat)} – ${formatProgrammeTime(String(Math.round(marker.stopMs / 1000)), catchup!.clockFormat)}`}
              />
            ))}
          </div>
        )}
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
        {extentLabel !== null && <span className="player-seekbar-extent">{extentLabel}</span>}
      </div>
      <span className={`player-seekbar-live-dot${isLive ? ' player-seekbar-live-dot--active' : ''}`} title={isLive ? 'At live edge' : 'Behind live'} />
    </div>
  )
}
