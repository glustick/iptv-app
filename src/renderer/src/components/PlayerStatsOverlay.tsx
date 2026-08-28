import { useEffect, useState, type RefObject } from 'react'
import type Hls from 'hls.js'

const POLL_INTERVAL_MS = 1000

// webkitVideoDecodedByteCount/webkitAudioDecodedByteCount are real, long-standing Chromium
// extensions (not in the standard DOM lib types) — same APIs this project's own CDP test
// scripts already rely on to confirm audio/video are actually decoding, reused here to show
// the same thing to the user instead of just to an automated test.
interface ChromiumVideoElement extends HTMLVideoElement {
  webkitVideoDecodedByteCount?: number
  webkitAudioDecodedByteCount?: number
  webkitDecodedFrameCount?: number
}

interface Stats {
  resolution: string
  playbackState: string
  time: string
  bufferedAheadSeconds: number
  droppedFrames: number
  totalFrames: number
  videoKbps: number | null
  audioKbps: number | null
  levelInfo: string | null
  bandwidthEstimateKbps: number | null
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function bufferedAhead(video: HTMLVideoElement): number {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
      return video.buffered.end(i) - video.currentTime
    }
  }
  return 0
}

export function PlayerStatsOverlay({
  videoRef,
  hlsRef
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  hlsRef: RefObject<Hls | null>
}): JSX.Element | null {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    // Deltas (bytes decoded since the last tick) are what make the byte counters meaningful as
    // a live "is this actually still decoding" signal — the raw running totals only ever grow,
    // so a stalled stream would otherwise look identical to a healthy one at a glance.
    let lastVideoBytes: number | null = null
    let lastAudioBytes: number | null = null

    const interval = setInterval(() => {
      const video = videoRef.current as ChromiumVideoElement | null
      if (!video) return

      const videoBytes = video.webkitVideoDecodedByteCount
      const audioBytes = video.webkitAudioDecodedByteCount
      const videoKbps =
        typeof videoBytes === 'number' && lastVideoBytes !== null
          ? Math.round(((videoBytes - lastVideoBytes) * 8) / 1000 / (POLL_INTERVAL_MS / 1000))
          : null
      const audioKbps =
        typeof audioBytes === 'number' && lastAudioBytes !== null
          ? Math.round(((audioBytes - lastAudioBytes) * 8) / 1000 / (POLL_INTERVAL_MS / 1000))
          : null
      lastVideoBytes = videoBytes ?? null
      lastAudioBytes = audioBytes ?? null

      const quality = video.getVideoPlaybackQuality?.()
      const hls = hlsRef.current
      const level = hls && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : null

      setStats({
        resolution: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—',
        playbackState: video.paused ? 'Paused' : video.ended ? 'Ended' : 'Playing',
        time: Number.isFinite(video.duration) ? `${formatTime(video.currentTime)} / ${formatTime(video.duration)}` : formatTime(video.currentTime),
        bufferedAheadSeconds: Math.round(bufferedAhead(video)),
        droppedFrames: quality?.droppedVideoFrames ?? 0,
        totalFrames: quality?.totalVideoFrames ?? 0,
        videoKbps,
        audioKbps,
        levelInfo: level ? `${level.width}×${level.height} · ${level.videoCodec ?? level.codecSet ?? ''} @ ${Math.round(level.bitrate / 1000)} kbps` : null,
        bandwidthEstimateKbps: hls ? Math.round(hls.bandwidthEstimate / 1000) : null
      })
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [videoRef, hlsRef])

  if (!stats) return null

  return (
    <div className="player-stats-overlay">
      <div className="player-stats-row">
        <span>Resolution</span>
        <span>{stats.resolution}</span>
      </div>
      <div className="player-stats-row">
        <span>State</span>
        <span>{stats.playbackState}</span>
      </div>
      <div className="player-stats-row">
        <span>Time</span>
        <span>{stats.time}</span>
      </div>
      <div className="player-stats-row">
        <span>Buffered ahead</span>
        <span>{stats.bufferedAheadSeconds}s</span>
      </div>
      <div className="player-stats-row">
        <span>Dropped frames</span>
        <span>
          {stats.droppedFrames} / {stats.totalFrames}
        </span>
      </div>
      <div className="player-stats-row">
        <span>Video bitrate</span>
        <span>{stats.videoKbps === null ? '—' : `${stats.videoKbps} kbps`}</span>
      </div>
      <div className="player-stats-row">
        <span>Audio bitrate</span>
        <span>{stats.audioKbps === null ? '—' : `${stats.audioKbps} kbps`}</span>
      </div>
      {stats.levelInfo && (
        <div className="player-stats-row">
          <span>HLS level</span>
          <span>{stats.levelInfo}</span>
        </div>
      )}
      {stats.bandwidthEstimateKbps !== null && (
        <div className="player-stats-row">
          <span>Bandwidth est.</span>
          <span>{stats.bandwidthEstimateKbps} kbps</span>
        </div>
      )}
    </div>
  )
}
