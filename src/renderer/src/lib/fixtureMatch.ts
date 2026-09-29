// Pairing the API's events with the provider's own game rows, and finding channels for an event
// the provider does not name.
//
// The Sports tab is fed from two independent sources: the API's day list (the pane's content) and
// the provider's channel catalogue (where the games actually play). The two spell teams
// differently often enough that they need joining — the API's "Newcastle United" against the
// provider's "Newcastle", or "Brighton & Hove Albion" against "Brighton" — so the join runs in two
// tiers and is deliberately conservative at every step: a *wrong* channel list under a selected
// game is worse than an empty one.
//
// Everything here is pure and unit-tested; it was ported from the web sibling's own
// matchFixturesToGames/channelsMentioningTeams, which settled these same rules on 2026-09-28.
//
// Pure module: no window/document/Electron imports (docs/STATE.md).

import type { LiveStream } from './types'
import { teamMatchKey } from './sports'
import type { SportEvent } from './api-sports'

/** The key an event and a provider game share when they are the same match. Both sides run through
 * the provider parser's own team normalization, then the pair is sorted — so "Newcastle United vs
 * Sunderland" and "Sunderland vs Newcastle" agree, and club suffixes ("Hull City AFC") don't stop
 * a match. */
export function eventMatchKey(event: Pick<SportEvent, 'homeName' | 'awayName'>): string {
  return [teamMatchKey(event.homeName), teamMatchKey(event.awayName)].sort().join(' vs ')
}

/** Index a day's events by match key. A live/finished entry wins a collision — it is the one
 * carrying a score worth showing. */
export function indexEventsByMatch(events: SportEvent[]): Map<string, SportEvent> {
  const byMatch = new Map<string, SportEvent>()
  for (const event of events) {
    const key = eventMatchKey(event)
    if (!key.trim() || key === ' vs ') continue
    const existing = byMatch.get(key)
    if (!existing || (!existing.live && !existing.finished && (event.live || event.finished))) {
      byMatch.set(key, event)
    }
  }
  return byMatch
}

// Words that describe half of sport and so can never carry a match on their own.
const GENERIC_TEAM_TOKENS = new Set(['united', 'city', 'town', 'club', 'de', 'la', 'real', 'sport', 'sports'])

function pairSides(pairKey: string): [string, string] {
  const parts = pairKey.split(' vs ')
  return [parts[0] ?? '', parts[1] ?? '']
}

/**
 * Whether two normalized team keys can be the same club: identical, or every token of the shorter
 * present in the longer ("newcastle" ⊂ "newcastle united"). The shorter side must keep at least one
 * real word, so a lone "united" or "city" cannot claim a match by itself.
 */
export function sideLooselyMatches(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const tokensA = a.split(' ').filter(Boolean)
  const tokensB = b.split(' ').filter(Boolean)
  if (tokensA.length === 0 || tokensB.length === 0) return false
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA]
  if (!shorter.every((token) => longer.includes(token))) return false
  return shorter.some((token) => token.length >= 3 && !GENERIC_TEAM_TOKENS.has(token))
}

/** Whether two pairs could be the same match, in either home/away order. */
export function loosePairMatches(gamePairKey: string, eventPairKey: string): boolean {
  const [g1, g2] = pairSides(gamePairKey)
  const [e1, e2] = pairSides(eventPairKey)
  return (
    (sideLooselyMatches(g1, e1) && sideLooselyMatches(g2, e2)) ||
    (sideLooselyMatches(g1, e2) && sideLooselyMatches(g2, e1))
  )
}

export interface EventPairing {
  /** provider game key → the event that is that match. */
  byGame: Map<string, SportEvent>
  /** The ids of events that claimed a game, i.e. are NOT provider-less. */
  matchedEventIds: Set<number>
}

/**
 * Pairs a day's events with a day's provider games. Exact matches win first; then each remaining
 * game takes a loose match **only when exactly one event could claim it** — an ambiguous match is
 * no match, and the event stays available for another game.
 */
export function matchEventsToGames(
  events: SportEvent[],
  games: Array<{ key: string; pairKey: string }>
): EventPairing {
  const byGame = new Map<string, SportEvent>()
  const matchedEventIds = new Set<number>()
  const exact = indexEventsByMatch(events)
  for (const game of games) {
    const event = exact.get(game.pairKey)
    if (event) {
      byGame.set(game.key, event)
      matchedEventIds.add(event.id)
    }
  }
  for (const game of games) {
    if (byGame.has(game.key)) continue
    const candidates = events.filter(
      (event) => !matchedEventIds.has(event.id) && loosePairMatches(game.pairKey, eventMatchKey(event))
    )
    if (candidates.length === 1 && candidates[0]) {
      byGame.set(game.key, candidates[0])
      matchedEventIds.add(candidates[0].id)
    }
  }
  return { byGame, matchedEventIds }
}

// Words that would match half a catalogue on their own, so a name search ignores them.
const SEARCH_STOPWORDS = new Set([
  'united', 'city', 'town', 'club', 'rovers', 'wanderers', 'athletic', 'albion', 'county', 'sporting',
  'sport', 'sports', 'the', 'real', 'de', 'la', 'fc', 'afc', 'sc', 'cf', 'ac', 'sv', 'as', 'ss', 'cd',
  'bk', 'if', 'fk', 'live', 'hd', 'fhd', 'uhd', 'feed', 'feeds'
])

/**
 * Channels whose names mention either side. This is the fallback behind an event the provider does
 * not carry under a recognisable name: it will not conjure a match, but it does surface the
 * channels that plausibly are about it, ranked by how many of the event's team words the name
 * contains.
 */
export function channelsMentioningTeams(channels: LiveStream[], home: string, away: string): LiveStream[] {
  const tokens = new Set(
    [...teamMatchKey(home).split(' '), ...teamMatchKey(away).split(' ')].filter(
      (token) => token.length >= 4 && !SEARCH_STOPWORDS.has(token)
    )
  )
  if (tokens.size === 0) return []
  const hits: Array<{ channel: LiveStream; score: number }> = []
  for (const channel of channels) {
    const name = channel.name.toLowerCase()
    let score = 0
    for (const token of tokens) if (name.includes(token)) score += 1
    if (score > 0) hits.push({ channel, score })
  }
  return hits
    .sort((a, b) => b.score - a.score || a.channel.name.localeCompare(b.channel.name))
    .map((hit) => hit.channel)
}
