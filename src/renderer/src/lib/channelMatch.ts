/**
 * The small decisions behind the per-channel match panel (see ChannelMatchModal).
 *
 * Why this exists at all: matching a channel used to mean opening the guide page, opening that
 * source's editor, finding the app channel in one pane of a 30,000-entry list and the guide channel
 * in another. Reported as "i dont like the layout for individual channel matching, its too much",
 * with the better shape spelled out: right-click the channel, pick the source, and see what is
 * already mapped plus a short list of likely matches. That is what these helpers support — and the
 * one place they need judgement is which candidates are worth putting in front of a person.
 */

import type { GuideCandidate } from './epg'

/**
 * At or above this, a candidate is presented as a strong match. Chosen to line up with the app's own
 * bulk-apply default (0.8), so "strong" here means the same thing it means everywhere else: a
 * near-miss that is unambiguous ("101 BBC One HD London" vs "BBC One" scores 0.8, a
 * quality-suffix-only difference scores 1.0).
 */
export const STRONG_MATCH_SCORE = 0.8

/**
 * The floor the panel asks for when listing candidates — deliberately below the calibrated
 * suggestion floor (0.6, see SUGGESTION_MIN_SCORE): the whole point of showing a *person* a list is
 * that they can recognise a match the scorer hesitates over, and every row carries its own score so
 * a weak one is visibly weak. Below ~0.4 the two names share so little that the list stops being
 * useful and starts being noise.
 */
export const POSSIBLE_MATCH_SCORE = 0.4

export type MatchTier = 'strong' | 'possible'

export interface TieredCandidate extends GuideCandidate {
  tier: MatchTier
}

/** Tags each candidate strong/possible and keeps the incoming (score, then name) order. */
export function tierCandidates(candidates: GuideCandidate[], strongAt = STRONG_MATCH_SCORE): TieredCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    tier: candidate.score >= strongAt ? 'strong' : 'possible'
  }))
}

/**
 * Which source the panel should start on: the one already supplying this channel if that is a
 * mappable (custom) source, otherwise the first visible one, otherwise the first there is. Never the
 * provider's own guide — that is not manually mappable (its channel ids are what epg_channel_id
 * already refers to; see EpgChannelMapping), so offering it would be offering a dead end.
 */
export function pickDefaultMatchSource(
  sources: string[],
  currentSupplier: string | null | undefined,
  providerLabel: string,
  hiddenSources: string[] = []
): string | null {
  const mappable = sources.filter((source) => source !== providerLabel)
  if (mappable.length === 0) return null
  if (currentSupplier && mappable.includes(currentSupplier)) return currentSupplier
  return mappable.find((source) => !hiddenSources.includes(source)) ?? mappable[0]
}
