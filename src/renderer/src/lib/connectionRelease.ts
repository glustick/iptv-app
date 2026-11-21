// Auto-release at the single-connection ceiling (0.32.0). When an account only allows one
// connection, the empty tile's old answer to "a channel is already playing" was a dead-end
// paragraph telling the viewer to go clear a tile themselves. This module is the honest
// alternative: decide WHICH of this grid's own tiles to stop so the tile the viewer is looking
// at can play instead — ported from the web sibling's v0.107/v0.113 connectionRelease, adapted
// to what the desktop actually knows.
//
// The idlest-tile rule, and how it differs from the web app: the web repo has a connection
// ledger that reports per-tile idle time, so its "idlest" is a real measurement. The desktop
// tracks no per-tile activity at all — a tile is either making sound or it isn't — so the
// strongest available signal is audio: the audible tile is NEVER stopped (sound is the clearest
// sign someone is watching that one), and among the silent tiles the earliest slot index goes,
// a stable, explainable tie-break rather than a pretend measurement.

import type { LiveStream } from './types'

/** One filled tile, as the release decision sees it. */
export interface ReleaseCandidate {
  slotIndex: number
  channelName: string
  /** Whether this tile is the one making sound — never the one stopped. */
  isAudible: boolean
}

export interface AutoReleasePlan {
  /** The slot to clear so the account's one connection is free. */
  slotIndex: number
  /** What the toolbar note should say — the viewer must be told which tile went and why. */
  note: string
}

/**
 * Which silent tile to stop for a single-connection account, or null when there is nothing
 * honest to stop: no tile is eligible (every filled tile is audible — the only filled tile IS
 * the one being watched) or the account isn't at its ceiling in the first place.
 */
export function planConnectionRelease(
  candidates: ReleaseCandidate[],
  atCeiling: boolean
): AutoReleasePlan | null {
  if (!atCeiling) return null
  const eligible = candidates.filter((c) => !c.isAudible)
  if (eligible.length === 0) return null
  // Lowest slot index wins: with no activity data to rank by, position is the only stable,
  // non-arbitrary-looking order the note can lean on.
  const victim = eligible.reduce((a, b) => (a.slotIndex <= b.slotIndex ? a : b))
  return {
    slotIndex: victim.slotIndex,
    note: `“${victim.channelName}” was stopped — this account allows only one connection, so pick a channel to play here instead.`
  }
}

/** Builds the candidate list from the grid's own state — the desktop's idle proxy is audio. */
export function releaseCandidates(
  slots: (LiveStream | null)[],
  audibleSlot: number | null
): ReleaseCandidate[] {
  return slots.flatMap((channel, slotIndex) =>
    channel ? [{ slotIndex, channelName: channel.name, isAudible: audibleSlot === slotIndex }] : []
  )
}
