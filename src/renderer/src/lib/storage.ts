import type { XtreamProfile, FavoriteEntry, RecentlyWatchedEntry, EpisodeProgress, AppSettings } from './types'
import { DEFAULT_SETTINGS } from './types'

const PROFILES_KEY = 'xtream_profiles'
const ACTIVE_PROFILE_KEY = 'active_profile_id'
const FAVORITES_KEY = 'favorites'
const RECENTLY_WATCHED_KEY = 'recently_watched'
const EPISODE_PROGRESS_KEY = 'episode_progress'
const SETTINGS_KEY = 'settings'

function hasElectronApi(): boolean {
  return typeof window !== 'undefined' && 'api' in window
}

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  if (hasElectronApi()) {
    const value = await window.api.store.get(key)
    return (value as T | undefined) ?? fallback
  }
  const raw = localStorage.getItem(key)
  return raw ? (JSON.parse(raw) as T) : fallback
}

async function saveJson<T>(key: string, value: T): Promise<void> {
  if (hasElectronApi()) {
    await window.api.store.set(key, value)
    return
  }
  localStorage.setItem(key, JSON.stringify(value))
}

export async function loadProfiles(): Promise<XtreamProfile[]> {
  return loadJson(PROFILES_KEY, [])
}

export async function saveProfiles(profiles: XtreamProfile[]): Promise<void> {
  return saveJson(PROFILES_KEY, profiles)
}

export async function loadActiveProfileId(): Promise<string | undefined> {
  if (hasElectronApi()) {
    return (await window.api.store.get(ACTIVE_PROFILE_KEY)) as string | undefined
  }
  return localStorage.getItem(ACTIVE_PROFILE_KEY) ?? undefined
}

export async function saveActiveProfileId(id: string): Promise<void> {
  if (hasElectronApi()) {
    await window.api.store.set(ACTIVE_PROFILE_KEY, id)
    return
  }
  localStorage.setItem(ACTIVE_PROFILE_KEY, id)
}

export async function loadFavorites(): Promise<FavoriteEntry[]> {
  return loadJson(FAVORITES_KEY, [])
}

export async function saveFavorites(favorites: FavoriteEntry[]): Promise<void> {
  return saveJson(FAVORITES_KEY, favorites)
}

export async function loadRecentlyWatched(): Promise<RecentlyWatchedEntry[]> {
  return loadJson(RECENTLY_WATCHED_KEY, [])
}

export async function saveRecentlyWatched(entries: RecentlyWatchedEntry[]): Promise<void> {
  return saveJson(RECENTLY_WATCHED_KEY, entries)
}

export async function loadEpisodeProgress(): Promise<Record<string, EpisodeProgress>> {
  return loadJson(EPISODE_PROGRESS_KEY, {})
}

export async function saveEpisodeProgress(progress: Record<string, EpisodeProgress>): Promise<void> {
  return saveJson(EPISODE_PROGRESS_KEY, progress)
}

export async function loadSettings(): Promise<AppSettings> {
  const loaded = await loadJson<Partial<AppSettings>>(SETTINGS_KEY, {})
  return { ...DEFAULT_SETTINGS, ...loaded }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  return saveJson(SETTINGS_KEY, settings)
}
