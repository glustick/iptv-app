import { useEffect, useRef, type RefObject } from 'react'
import Hls from 'hls.js'
import { useTranscodeFallback } from './useTranscodeFallback'

const HLS_CONFIG = { enableWorker: true, maxBufferLength: 15, maxMaxBufferLength: 30 }

/**
 * Lightweight HLS attach for secondary/background video elements (e.g. a small preview),
 * as opposed to the full-featured setup in Player.tsx (retries, progress tracking, PiP,
 * keyboard shortcuts). No general retry logic here on purpose — a preview that fails to load
 * just shows nothing; it isn't worth the complexity of Player's recovery path for a muted
 * thumbnail. The one exception is the EC-3/AC-3 audio-transcode fallback (see
 * useTranscodeFallback): that failure mode doesn't just kill audio, it kills the whole
 * fragment's demux — video freezes too, muted or not — so it's worth fixing here as well.
 */
export function useHlsAttach(videoRef: RefObject<HTMLVideoElement>, url: string | null, muted = true): void {
  const lastUrlRef = useRef<string | null>(null)
  const { getSourceUrl, tryFallback, reset: resetTranscodeFallback, beginRun: beginTranscodeRun } = useTranscodeFallback()

  useEffect(() => {
    if (url !== lastUrlRef.current) {
      lastUrlRef.current = url
      resetTranscodeFallback()
    }
  }, [url, resetTranscodeFallback])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !url) return

    let hls: Hls | null = null
    video.muted = muted
    beginTranscodeRun()

    // Wraps a fresh Hls instance for the given source with the transcode-fallback error
    // handler — factored out so a successful fallback (which swaps in a different source
    // without url itself changing) can re-attach identically rather than the reload path
    // silently ending up with no error handling at all.
    function attach(sourceUrl: string): void {
      if (!video) return
      if (sourceUrl.endsWith('.m3u8') && Hls.isSupported()) {
        const instance = new Hls(HLS_CONFIG)
        hls = instance
        instance.loadSource(sourceUrl)
        instance.attachMedia(video)
        instance.on(Hls.Events.ERROR, (_event, data) => {
          tryFallback(data, url!, () => {
            instance.destroy()
            attach(getSourceUrl(url!))
            video.play().catch(() => {})
          })
        })
      } else {
        video.src = sourceUrl
      }
      video.play().catch(() => {})
    }

    attach(getSourceUrl(url))

    return () => {
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [videoRef, url, muted, getSourceUrl, tryFallback, beginTranscodeRun])
}
