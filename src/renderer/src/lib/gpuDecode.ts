/**
 * Turns Chromium's GPU feature status into a single honest line for the stats overlay.
 *
 * Why it exists: this app never re-encodes video (its only transcode stream-copies the video and
 * fixes the audio), so the GPU's real job here is *decoding* — and Chromium does that silently.
 * On a machine with a discrete GPU, "is the GPU actually doing the decode, or is the CPU carrying
 * it?" is invisible everywhere in the app, and it is the one quality-neutral answer a user with
 * capable hardware actually wants. Worth surfacing precisely because it is the moment something
 * is *not* working: a driver fault or a GPU blocklist entry quietly moves decode to the CPU, and
 * the symptom (high CPU, dropped frames) looks like a stream problem.
 *
 * Kept pure and tested: the statuses are Chromium's, but the wording is ours, and a diagnostic
 * row that lies is worse than no row at all — so unknown values are reported rather than hidden
 * or guessed at.
 */

export interface GpuSummary {
  /** `app.getGPUFeatureStatus().video_decode` — 'enabled' | 'software' | 'disabled' | 'unavailable' | 'blocklisted' | … */
  videoDecode: string | null
  /** Active GPU device names where the platform reports them (e.g. 'NVIDIA GeForce RTX 3080 Ti'). */
  devices: string[]
}

export function describeGpuDecode(summary: GpuSummary | null | undefined): string | null {
  const status = summary?.videoDecode
  if (!status) return null
  const device = summary?.devices?.find((name) => !!name) ?? null

  switch (status) {
    case 'enabled':
      return device ? `Hardware — ${device}` : 'Hardware'
    case 'software':
      // The important case: everything works, but the CPU is doing the decoding.
      return 'Software only (GPU decoding is unavailable)'
    case 'disabled':
      return 'Disabled'
    case 'unavailable':
      return 'Unavailable'
    case 'blocklisted':
      return "Blocked by Chromium's GPU blocklist"
    default:
      // Never pretend to know what a future status means.
      return status
  }
}
