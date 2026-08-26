import type { XtreamProfile } from './types'

const PROFILES_KEY = 'xtream_profiles'
const ACTIVE_PROFILE_KEY = 'active_profile_id'

function hasElectronApi(): boolean {
  return typeof window !== 'undefined' && 'api' in window
}

export async function loadProfiles(): Promise<XtreamProfile[]> {
  if (hasElectronApi()) {
    return ((await window.api.store.get(PROFILES_KEY)) as XtreamProfile[] | undefined) ?? []
  }
  return JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]')
}

export async function saveProfiles(profiles: XtreamProfile[]): Promise<void> {
  if (hasElectronApi()) {
    await window.api.store.set(PROFILES_KEY, profiles)
    return
  }
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
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
