import type { XtreamProfile, FavoriteEntry, FavoriteGroup, RecentlyWatchedEntry, EpisodeProgress, AppSettings } from './types'
import type { EpgReminder } from './reminders'
import { DEFAULT_SETTINGS } from './types'

const PROFILES_KEY = 'xtream_profiles'
const ACTIVE_PROFILE_KEY = 'active_profile_id'
const FAVORITES_KEY = 'favorites'
const FAVORITE_GROUPS_KEY = 'favorite_groups'
const RECENTLY_WATCHED_KEY = 'recently_watched'
const EPISODE_PROGRESS_KEY = 'episode_progress'
const SETTINGS_KEY = 'settings'
const EPG_REMINDERS_KEY = 'epg_reminders'

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

export async function loadFavoriteGroups(): Promise<FavoriteGroup[]> {
  return loadJson(FAVORITE_GROUPS_KEY, [])
}

export async function saveFavoriteGroups(groups: FavoriteGroup[]): Promise<void> {
  return saveJson(FAVORITE_GROUPS_KEY, groups)
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

export async function loadEpgReminders(): Promise<EpgReminder[]> {
  return loadJson(EPG_REMINDERS_KEY, [])
}

export async function saveEpgReminders(reminders: EpgReminder[]): Promise<void> {
  return saveJson(EPG_REMINDERS_KEY, reminders)
}

// The parental PIN used to be stored as plain text in electron-store's JSON file, on the same
// footing as everything else there — fine for "don't let a kid stumble into the wrong
// category," not fine against anyone who'd think to just open the file. safeStorage is
// main-process-only (hence the IPC round-trip) and OS-keychain-backed (macOS Keychain, Windows
// DPAPI, Linux Secret Service where a keyring daemon is actually running — isAvailable() can be
// false there, in which case this falls back to the old plaintext behavior rather than losing
// the feature). The rest of the app never sees any of this: the plaintext fields below are
// always plain text in memory, encrypted/decrypted only at this load/save boundary. The VPN
// username/password (added alongside the OpenVPN feature) are real account credentials, not
// just a local access PIN, so they use the exact same treatment rather than a weaker one.
const ENCRYPTED_PREFIX = 'enc:'

async function encryptSecret(value: string): Promise<string> {
  if (!hasElectronApi()) return value
  const available = await window.api.safeStorage.isAvailable().catch(() => false)
  if (!available) return value
  const encrypted = await window.api.safeStorage.encrypt(value).catch(() => null)
  return encrypted === null ? value : ENCRYPTED_PREFIX + encrypted
}

async function decryptSecret(stored: string, label: string): Promise<string | null> {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored // legacy plaintext, used as-is
  if (!hasElectronApi()) return null // no main process to ask — can't decrypt here
  return window.api.safeStorage.decrypt(stored.slice(ENCRYPTED_PREFIX.length)).catch(() => {
    // Only realistically hit if the encrypted value came from a different machine/OS-key
    // context (e.g. a copied userData folder) — the original value can't be recovered at that
    // point, so this fails open (treated as unset) rather than permanently locking the feature
    // behind a value nothing can ever decrypt again. Matches this app's existing "soft lock"
    // threat model: worse than losing a stored secret would be no recovery path at all.
    console.error(`[settings] failed to decrypt ${label} — treating as unset`)
    return null
  })
}

export async function loadSettings(): Promise<AppSettings> {
  const loaded = await loadJson<Partial<AppSettings>>(SETTINGS_KEY, {})
  const merged = { ...DEFAULT_SETTINGS, ...loaded }
  // Locked category IDs used to be stored bare (just the Xtream category_id), shared across
  // Live/Movies/Series — but Xtream doesn't guarantee those IDs are unique across sections,
  // so a bare ID could lock the wrong section's category. IDs are now namespaced as
  // "section:id"; drop any legacy bare ones rather than guessing which section they meant —
  // applying a lock to the wrong section would be worse than a one-time reset.
  const result = { ...merged }
  // Shape-harden the fields that render as lists/objects all over the app — a partially-written
  // or externally-corrupted settings file (disk-full mid-write, endpoint-security rollback,
  // hand-editing) used to surface as silently broken UI: a non-array customEpgUrls, for one,
  // made the EPG sources list vanish while in-memory pool state kept those sources alive and
  // unremovable. Resetting the one bad field to its default loses that list but keeps the app
  // working and logs exactly what happened — strictly better than the silent misbehavior.
  if (!Array.isArray(result.lockedCategoryIds)) {
    console.warn('[settings] lockedCategoryIds was not an array on disk — resetting it')
    result.lockedCategoryIds = []
  }
  if (!Array.isArray(result.customEpgUrls)) {
    console.warn('[settings] customEpgUrls was not an array on disk — resetting it')
    result.customEpgUrls = []
  }
  if (!Array.isArray(result.epgChannelMappings)) {
    console.warn('[settings] epgChannelMappings was not an array on disk — resetting it')
    result.epgChannelMappings = []
  }
  if (!Array.isArray(result.vpnProfiles)) {
    console.warn('[settings] vpnProfiles was not an array on disk — resetting it')
    result.vpnProfiles = []
  }
  if (!Array.isArray(result.hiddenLiveStreamIds)) {
    console.warn('[settings] hiddenLiveStreamIds was not an array on disk — resetting it')
    result.hiddenLiveStreamIds = []
  }
  if (typeof result.liveAudioFixes !== 'object' || result.liveAudioFixes === null || Array.isArray(result.liveAudioFixes)) {
    console.warn('[settings] liveAudioFixes was not an object on disk — resetting it')
    result.liveAudioFixes = {}
  }
  // Namespaced lock IDs — drop legacy bare ones rather than guessing which section they meant.
  result.lockedCategoryIds = result.lockedCategoryIds.filter((id) => id.includes(':'))
  let needsMigration = false
  if (result.parentalPin) {
    const wasLegacyPlaintext = !result.parentalPin.startsWith(ENCRYPTED_PREFIX)
    result.parentalPin = await decryptSecret(result.parentalPin, 'parental PIN')
    if (wasLegacyPlaintext && result.parentalPin) needsMigration = true
  }
  // Each saved VPN profile carries its own optional username/password (some .ovpn files are
  // cert-only and need neither) — decrypted the same way as the PIN, independently per profile,
  // since profiles are added/removed over time and there's no single shared secret to migrate.
  result.vpnProfiles = await Promise.all(
    result.vpnProfiles.map(async (profile) => {
      if (!profile.username && !profile.password) return profile
      const wasLegacyPlaintext =
        (!!profile.username && !profile.username.startsWith(ENCRYPTED_PREFIX)) ||
        (!!profile.password && !profile.password.startsWith(ENCRYPTED_PREFIX))
      if (wasLegacyPlaintext) needsMigration = true
      return {
        ...profile,
        username: profile.username ? await decryptSecret(profile.username, `VPN username (${profile.name})`) : null,
        password: profile.password ? await decryptSecret(profile.password, `VPN password (${profile.name})`) : null
      }
    })
  )
  // Migrate immediately rather than waiting for some unrelated setting to change next —
  // otherwise a user who never opens Settings again keeps existing plaintext secrets on disk
  // indefinitely even after upgrading to a build that knows how to encrypt them.
  if (needsMigration) {
    saveSettings(result).catch((err) => console.error('[storage] failed to migrate legacy plaintext secrets:', err))
  }
  return result
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const toSave = { ...settings }
  if (toSave.parentalPin) {
    toSave.parentalPin = await encryptSecret(toSave.parentalPin)
  }
  toSave.vpnProfiles = await Promise.all(
    toSave.vpnProfiles.map(async (profile) => ({
      ...profile,
      username: profile.username ? await encryptSecret(profile.username) : null,
      password: profile.password ? await encryptSecret(profile.password) : null
    }))
  )
  return saveJson(SETTINGS_KEY, toSave)
}
