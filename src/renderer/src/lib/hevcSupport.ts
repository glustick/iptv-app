/**
 * Whether this client can actually decode HEVC from fragmented MP4 in MSE.
 *
 * Why it exists: the live remux has to know whether to hand Chromium a *copy* of an HEVC stream
 * (tagged hvc1, lossless) or to re-encode it to H.264. Chromium refuses HEVC-in-MSE outright
 * when the platform has no HEVC decoder — GPU video decode is routinely unavailable (this app's
 * own startup log has recorded `disabled_software`) and Chromium ships no software HEVC
 * decoder — so the copied stream would be appended and fail with `bufferAddCodecError`, leaving
 * the channel with no picture at all. Only the renderer can ask, hence this helper and
 * `transcode.setHevcSupport`.
 *
 * Cached: the answer cannot change while the process lives (it depends on the platform's
 * decoders, not on anything the app does), and `isTypeSupported` is cheap but not free.
 *
 * The codec string is the standard Main-profile hvc1 form. A renderer with no `MediaSource` at
 * all (should not happen in Electron, but this module is also reachable from tests) is treated
 * as "cannot decode" — the safe direction, because the only cost is CPU on a machine that was
 * never going to show the picture otherwise.
 */
let cached: boolean | null = null

export function clientCanDecodeHevc(): boolean {
  if (cached !== null) return cached
  try {
    cached =
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')
  } catch {
    cached = false
  }
  return cached
}
