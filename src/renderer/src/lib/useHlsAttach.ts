import { useEffect, type RefObject } from 'react'
import Hls from 'hls.js'

/**
 * Lightweight HLS attach for secondary/background video elements (e.g. a small preview),
 * as opposed to the full-featured setup in Player.tsx (retries, progress tracking, PiP,
 * keyboard shortcuts). No retry logic here on purpose — a preview that fails to load just
 * shows nothing; it isn't worth the complexity of Player's recovery path for a muted thumbnail.
 */
export function useHlsAttach(videoRef: RefObject<HTMLVideoElement>, url: string | null, muted = true): void {
  useEffect(() => {
    const video = videoRef.current
    if (!video || !url) return

    let hls: Hls | null = null
    video.muted = muted

    if (url.endsWith('.m3u8') && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, maxBufferLength: 15, maxMaxBufferLength: 30 })
      hls.loadSource(url)
      hls.attachMedia(video)
    } else {
      video.src = url
    }
    video.play().catch(() => {})

    return () => {
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [videoRef, url, muted])
}
