import { useEffect, useState, type RefObject } from 'react'
import type Hls from 'hls.js'
import { hasInformativeLevelData } from '../lib/hlsLevels'
import { describeGpuDecode } from '../lib/gpuDecode'

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
  // Whether the live channel's own playlist is still advancing. Several providers serve a
  // *finished* playlist on a live URL (this app's does, on many channels) — a fixed loop of
  // whatever length it was cut at — and knowing that explains behaviour nothing else does.
  playlistState: string | null
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
  hlsRef,
  isLive = false
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  hlsRef: RefObject<Hls | null>
  // Only live content gets the "playlist" row below: a finished playlist is normal (and correct)
  // for VOD and for the audio-fix transcode's own output, so reporting it there would be noise.
  isLive?: boolean
}): JSX.Element | null {
  const [stats, setStats] = useState<Stats | null>(null)
  // Fetched once per open: this describes the GPU/Chromium state, which changes far less often
  // than the per-second frame counters the interval below tracks.
  const [gpuDecode, setGpuDecode] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.app
      .getGpuSummary()
      .then((summary) => {
        if (!cancelled) setGpuDecode(describeGpuDecode(summary))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

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
      // A flat single-rendition source (what these providers serve) reports a level carrying no
      // dimensions and no bitrate — rendering "0×0 · @ 0 kbps" dresses noise up as diagnostics, so
      // the row is omitted entirely unless the level actually says something.
      const levelInfo = hasInformativeLevelData(level)
        ? `${level?.width}×${level?.height} · ${level?.videoCodec ?? level?.codecSet ?? ''} @ ${Math.round((level?.bitrate ?? 0) / 1000)} kbps`
        : null
      // Likewise the bandwidth estimate: it exists to explain which rendition ABR picked, and on a
      // single-rendition feed it has nothing to compare — it reported a nonsensical ~300 Mbit/s in
      // live testing, which is worse than showing nothing at all.
      const bandwidthEstimateKbps = hls && hls.levels.length > 1 ? Math.round(hls.bandwidthEstimate / 1000) : null

      setStats({
        resolution: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—',
        playbackState: video.paused ? 'Paused' : video.ended ? 'Ended' : 'Playing',
        time: Number.isFinite(video.duration) ? `${formatTime(video.currentTime)} / ${formatTime(video.duration)}` : formatTime(video.currentTime),
        bufferedAheadSeconds: Math.round(bufferedAhead(video)),
        droppedFrames: quality?.droppedVideoFrames ?? 0,
        totalFrames: quality?.totalVideoFrames ?? 0,
        videoKbps,
        audioKbps,
        levelInfo,
        playlistState:
          isLive && level?.details
            ? level.details.live
              ? 'Live (advancing)'
              : 'Fixed loop (finished playlist)'
            : null,
        bandwidthEstimateKbps
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
      {gpuDecode && (
        <div className="player-stats-row">
          <span>GPU decode</span>
          <span>{gpuDecode}</span>
        </div>
      )}
      {stats.playlistState && (
        <div className="player-stats-row">
          <span>Playlist</span>
          <span>{stats.playlistState}</span>
        </div>
      )}
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
