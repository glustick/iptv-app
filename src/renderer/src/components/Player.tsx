import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { useAppStore } from '../store/useAppStore'

export function Player(): JSX.Element | null {
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const stop = useAppStore((s) => s.stop)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !nowPlaying) return

    setPlaybackError(null)

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const isM3u8 = nowPlaying.url.endsWith('.m3u8')

    if (isM3u8 && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true })
      hlsRef.current = hls
      hls.loadSource(nowPlaying.url)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setPlaybackError(`Playback error: ${data.details}`)
        }
      })
      video.play().catch(() => {})
    } else {
      video.src = nowPlaying.url
      video.play().catch(() => {})
    }

    return () => {
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
        <video ref={videoRef} className="player-video" controls autoPlay />
      </div>
    </div>
  )
}
