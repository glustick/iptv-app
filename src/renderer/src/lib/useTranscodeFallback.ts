import { useCallback, useRef, useState } from 'react'
import type { ErrorData } from 'hls.js'

/**
 * Detects a class of hls.js failures that share one real cause — a Dolby Digital
 * (AC-3/E-AC-3) audio track this app's playback engine can't handle: hls.js's own demuxer
 * refusing to parse EC-3 inside MPEG-TS at all (fatal fragParsingError), or Chromium's
 * SourceBuffer rejecting the codec once handed valid AAC-shaped data (non-fatal
 * bufferAddCodecError/bufferAppendError). No amount of retrying fixes either.
 */
export function isUnsupportedAudioCodecError(data: ErrorData): boolean {
  return (
    (data.details === 'fragParsingError' && typeof data.reason === 'string' && /ec-?3|ac-?3/i.test(data.reason)) ||
    ((data.details === 'bufferAddCodecError' || data.details === 'bufferAppendError') &&
      typeof data.mimeType === 'string' &&
      data.mimeType.toLowerCase().includes('audio'))
  )
}

/**
 * Shared remediation for the failure isUnsupportedAudioCodecError detects: spins up a local
 * ffmpeg process (see src/main/index.ts's transcode: IPC handlers) that remuxes just the
 * affected channel's audio to AAC, and falls back to that output. Used by both Player.tsx
 * (the fullscreen player) and useHlsAttach.ts (the small preview) so this detection and
 * remediation logic isn't duplicated between them — only the video actually froze/glitched
 * in each place, the fix is identical.
 */
export function useTranscodeFallback(): {
  transcoding: boolean
  getSourceUrl: (originalUrl: string) => string
  tryFallback: (data: ErrorData, originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
  reset: () => void
  beginRun: () => void
} {
  const transcodedUrlRef = useRef<string | null>(null)
  const triedTranscodeRef = useRef(false)
  const awaitingTranscodeRef = useRef(false)
  const transcodeSessionIdRef = useRef<string | null>(null)
  const [transcoding, setTranscoding] = useState(false)

  // Call when the underlying channel/stream identity changes (a genuinely different source,
  // not just a reload of the same one) — resets fallback state and stops any prior session.
  const reset = useCallback(() => {
    triedTranscodeRef.current = false
    awaitingTranscodeRef.current = false
    transcodedUrlRef.current = null
    const staleSessionId = transcodeSessionIdRef.current
    transcodeSessionIdRef.current = null
    if (staleSessionId) window.api.transcode.stop(staleSessionId)
  }, [])

  // Call at the top of every hls-(re)attach run — a fresh attempt (first try, or the reload
  // after a successful fallback) always starts with nothing already in flight; it only
  // becomes true again if this run's own error handler kicks one off.
  const beginRun = useCallback(() => {
    awaitingTranscodeRef.current = false
  }, [])

  const getSourceUrl = useCallback((originalUrl: string) => transcodedUrlRef.current ?? originalUrl, [])

  const tryFallback = useCallback(
    (data: ErrorData, originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      // Spinning up ffmpeg takes a few real seconds, during which the still-attached, still-
      // broken hls instance keeps hitting the identical error repeatedly. Once a fix is
      // already in flight there's nothing new to react to.
      if (awaitingTranscodeRef.current) return true
      if (!isUnsupportedAudioCodecError(data) || triedTranscodeRef.current) return false

      triedTranscodeRef.current = true
      awaitingTranscodeRef.current = true
      setTranscoding(true)
      window.api.transcode
        .start(originalUrl)
        .then(({ sessionId, url }) => {
          transcodeSessionIdRef.current = sessionId
          transcodedUrlRef.current = url
          onReload()
        })
        .catch((err) => {
          awaitingTranscodeRef.current = false
          onError?.(err instanceof Error ? err.message : String(err))
        })
        .finally(() => setTranscoding(false))
      return true
    },
    []
  )

  return { transcoding, getSourceUrl, tryFallback, reset, beginRun }
}
