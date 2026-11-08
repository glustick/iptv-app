import type { ViewMode } from '../store/useAppStore'

/**
 * The tab the app opens on — the web sibling's v0.93.0 rule ("reopens on the tab you were last
 * using"), per device, like every other browsing preference here.
 *
 * The type is imported from the store rather than redeclared: one list of tabs, or the two drift.
 * It is a type-only import, so nothing circular reaches the runtime (the store imports this file's
 * functions; this file imports only the store's type).
 */
const STORAGE_KEY = 'allisoniptv-last-view'
const VIEW_MODES: ViewMode[] = ['live', 'movies', 'series', 'sports', 'favorites', 'history', 'multiview']

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && (VIEW_MODES as string[]).includes(value)
}

/**
 * The bare `localStorage` global, not `window.localStorage`: the store imports this module, and
 * the store's own tests run in plain Node where the shim is installed on `globalThis`. Both names
 * are the same object in the app; only one of them exists in those tests.
 */
export function loadLastViewMode(): ViewMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return isViewMode(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveLastViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mode))
  } catch {
    // A blocked storage surface must not stop the app from switching tabs.
  }
}
