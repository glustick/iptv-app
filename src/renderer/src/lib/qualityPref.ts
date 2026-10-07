// The viewer's quality ceiling (v0.75.0 port from the web sibling): caps the re-encode tier's
// height on channels this machine can only play through the video re-encode (HEVC on a client
// without an HEVC decoder). Source — the default, and the app's standing decision (see the web
// sibling's v0.46.3) — means the picture the provider sent is never silently downscaled; a cap
// exists only because the viewer chose one. Per device, in the renderer's own localStorage, for
// the same reason the web sibling gave: it is a statement about *this machine's* playback, not
// about the channel or the account.
const STORAGE_KEY = 'allisoniptv-quality-pref'

export const MAX_HEIGHT_MIN = 240
export const MAX_HEIGHT_MAX = 2160

export function isValidMaxHeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MAX_HEIGHT_MIN && value <= MAX_HEIGHT_MAX
}

export function loadQualityMaxHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return isValidMaxHeight(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveQualityMaxHeight(value: number | null): void {
  try {
    // Normalize before storing: garbage in, Source out — a bad value can never travel to the
    // encoder, and "Source" removes the key entirely so absence stays the natural default.
    const normalized = value !== null && isValidMaxHeight(value) ? Math.round(value) : null
    if (normalized === null) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    }
  } catch {
    // A blocked storage surface must not take playback down with it — the choice just does not
    // persist, exactly like the web sibling's storage-less fallback to DEFAULT_PLAYER_PREFS.
  }
}
