import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { useAppStore } from '../store/useAppStore'

const MAX_NETWORK_RETRIES = 4

export function Player(): JSX.Element | null {
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const stop = useAppStore((s) => s.stop)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [buffering, setBuffering] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !nowPlaying) return

    setPlaybackError(null)
    setBuffering(true)
    let networkRetryCount = 0

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const handleWaiting = (): void => setBuffering(true)
    const handlePlaying = (): void => setBuffering(false)
    const handleCanPlay = (): void => setBuffering(false)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('playing', handlePlaying)
    video.addEventListener('canplay', handleCanPlay)

    const isM3u8 = nowPlaying.url.endsWith('.m3u8')

    if (isM3u8 && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        // Favor smooth, stutter-free playback over sitting right on the live edge: buffer
        // generously ahead so a brief network hiccup doesn't surface as visible rebuffering.
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 90,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 10,
        fragLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 6
      })
      hlsRef.current = hls
      hls.loadSource(nowPlaying.url)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
          // A codec/append error scoped to a single SourceBuffer (very often the audio
          // track — e.g. an AC-3/E-AC-3 feed, which Chromium has no decoder for) can
          // silently kill just that track while video keeps playing fine, with nothing
          // else ever surfacing the problem. Call it out explicitly instead.
          if (data.details === 'bufferAddCodecError' || data.details === 'bufferAppendError') {
            const isAudio = typeof data.mimeType === 'string' && data.mimeType.toLowerCase().includes('audio')
            setPlaybackError(
              `${isAudio ? 'Audio' : 'Video'} codec not supported by this player. This channel's ${isAudio ? 'audio' : 'video'} stream isn't compatible with this app's playback engine${isAudio ? ' (commonly AC-3/E-AC-3 audio, which this app cannot decode)' : ''}.`
            )
          }
          return
        }
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            networkRetryCount += 1
            if (networkRetryCount <= MAX_NETWORK_RETRIES) {
              hls.startLoad()
            } else {
              setPlaybackError(`Playback error: ${data.details} (gave up after ${MAX_NETWORK_RETRIES} retries)`)
              hls.destroy()
            }
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError()
            break
          default:
            setPlaybackError(`Playback error: ${data.details}`)
            hls.destroy()
        }
      })
      video.play().catch(() => {})
    } else {
      video.src = nowPlaying.url
      video.play().catch(() => {})
    }

    return () => {
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('canplay', handleCanPlay)
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [nowPlaying])

  if (!nowPlaying) return null

  return (
    <div className="player-overlay">
      <div className="player-header">
        <span className="player-title">{nowPlaying.name}</span>
        <button className="player-close" onClick={stop}>
          ✕ Close
        </button>
      </div>
      <div className="player-body">
        {playbackError && <div className="player-error">{playbackError}</div>}
        {buffering && !playbackError && (
          <div className="player-buffering">
            <div className="spinner" />
            <span>Buffering…</span>
          </div>
        )}
        <video ref={videoRef} className="player-video" controls autoPlay />
      </div>
    </div>
  )
}
