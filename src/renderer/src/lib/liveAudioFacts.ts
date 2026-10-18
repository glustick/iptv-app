/**
 * The cheap live-audio probe's per-channel verdict cache.
 *
 * Since the PMT fast probe landed in the main process (v0.15.2, ported from the web sibling's
 * v0.79.1), asking what a live channel's first audio track carries costs ~1-3s and one short
 * segment fetch instead of a whole second sustained ffmpeg connection — cheap enough to ask
 * proactively on a channel's first open rather than waiting out the silent-audio watchdog on an
 * E-AC-3-first channel (the Sky Sports FHD shape). But "cheap enough to ask once" is not
 * "cheap enough to ask on every open": this app has genuinely been used against
 * single-connection-capped accounts (see Player's singleConnectionAccount), where even a brief
 * second connection while the player loads can displace it. So the answer is remembered.
 *
 * Machine-local (localStorage, not the synced settings): the fact being cached is a property of
 * the provider's stream, but the question it answers — "does the first audio codec need
 * converting before THIS build plays it" — is per machine, and a fresh install re-probing once
 * per channel is exactly the cost this file exists to avoid repeating.
 *
 * Pure core (Record in, Record out) with a thin localStorage shell, same convention as the rest
 * of lib/ — see transcodeMemory.ts for the key and source-matching rules this mirrors.
 */

import { channelKey } from './channelIdentity'
import { sameSourceUrl } from './transcodeMemory'

/** What one channel's probe learned: its first audio track's codec (null = none/unknown). */
export interface LiveAudioFact {
  firstAudioCodec: string | null
  /** The source URL the fact was learned against — matched host+pathname (see transcodeMemory). */
  sourceUrl: string
  at: number
}

const STORAGE_KEY = 'allison:live-audio-facts'
const MAX_ENTRIES = 500

type LiveAudioFacts = Record<string, LiveAudioFact>

export function liveAudioFactKey(ref: {
  playlistId?: string | null
  streamId: number
  primaryPlaylistId?: string | null
}): string {
  return channelKey(ref.playlistId, ref.streamId, ref.primaryPlaylistId)
}

/** The remembered fact for a channel when it was learned against the same source, else null. */
export function findLiveAudioFact(facts: LiveAudioFacts, key: string, sourceUrl: string): LiveAudioFact | null {
  const fact = facts[key]
  if (!fact) return null
  return sameSourceUrl(fact.sourceUrl, sourceUrl) ? fact : null
}

/** Records one channel's fact, pruning the oldest half once the cache outgrows its ceiling. */
export function withLiveAudioFact(
  facts: LiveAudioFacts,
  key: string,
  sourceUrl: string,
  firstAudioCodec: string | null
): LiveAudioFacts {
  const next: LiveAudioFacts = { ...facts, [key]: { firstAudioCodec, sourceUrl, at: Date.now() } }
  const entries = Object.keys(next)
  if (entries.length <= MAX_ENTRIES) return next
  const oldestFirst = entries.sort((a, b) => next[a].at - next[b].at)
  for (const stale of oldestFirst.slice(0, entries.length - MAX_ENTRIES)) delete next[stale]
  return next
}

function readFacts(): LiveAudioFacts {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as LiveAudioFacts) : {}
  } catch {
    return {}
  }
}

export function rememberedLiveAudioFact(key: string, sourceUrl: string): LiveAudioFact | null {
  return findLiveAudioFact(readFacts(), key, sourceUrl)
}

export function rememberLiveAudioFact(key: string, sourceUrl: string, firstAudioCodec: string | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(withLiveAudioFact(readFacts(), key, sourceUrl, firstAudioCodec)))
  } catch {
    // A full or blocked localStorage is not worth failing playback over — worst case the
    // channel is probed again next open.
  }
}

/** Drops one channel's fact — for a provider-side change that invalidated what was learned. */
export function forgetLiveAudioFact(key: string): void {
  try {
    const next = readFacts()
    if (!(key in next)) return
    delete next[key]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Same policy as rememberLiveAudioFact: cache trouble never reaches the player.
  }
}
