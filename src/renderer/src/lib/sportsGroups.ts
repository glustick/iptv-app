// Grouping the Sports tab's day list into league subsections, and the league/country filters that
// sit above them.
//
// The middle pane's day list is one flat sorted list (live first, then upcoming by kickoff, then
// finished), and at a real day's scale — a Saturday of football is a hundred-plus rows across a
// dozen-plus competitions — it reads as soup. Grouping runs AFTER the sort, so each subsection
// keeps the pane's own ordering inside it and the subsections surface in the order the sorted
// list first reaches them (live competitions float to the top naturally).
//
// Pure module: no window/document/Electron imports (docs/STATE.md).

import type { SportEvent } from './api-sports'

/** One league subsection of the middle pane's day list. */
export interface SportLeagueGroup {
  /** Stable identity of the subsection: league + country, since different countries field
   * same-named competitions ("Premier League" is not only England's). */
  key: string
  league: string
  country: string
  /** This group's events, in the pane's own sort order (the caller's list order is preserved). */
  events: SportEvent[]
  /** How many of the group's games are in play right now — drives the header's LIVE badge. */
  liveCount: number
}

const GROUP_SEPARATOR = '\u001f'

/** The subsection's display label: "Premier League", or "Premier League · England" when the API
 * supplies a country for it. */
export function leagueGroupLabel(league: string, country: string): string {
  return country ? `${league} · ${country}` : league
}

function groupKeyOf(event: Pick<SportEvent, 'league' | 'country'>): string {
  return `${event.country}${GROUP_SEPARATOR}${event.league}`
}

/**
 * Group the day's events by their (country, league) pair. Order within a group preserves the
 * caller's order (the pane's sort); groups appear in first-appearance order, so live competitions
 * surface first — except the no-league bucket, which always sinks to the end: an event without a
 * league name is the odd one out, not a section worth promoting.
 */
export function groupEventsByLeague(events: SportEvent[]): SportLeagueGroup[] {
  const groups = new Map<string, SportLeagueGroup>()
  const tail: SportEvent[] = []
  for (const event of events) {
    if (!event.league.trim()) {
      tail.push(event)
      continue
    }
    const key = groupKeyOf(event)
    let group = groups.get(key)
    if (!group) {
      group = { key, league: event.league, country: event.country, events: [], liveCount: 0 }
      groups.set(key, group)
    }
    group.events.push(event)
    if (event.live) group.liveCount += 1
  }
  const ordered = [...groups.values()]
  if (tail.length > 0) {
    ordered.push({ key: GROUP_SEPARATOR, league: '', country: '', events: tail, liveCount: tail.filter((e) => e.live).length })
  }
  return ordered
}

/** The label an event's group renders — also the league filter's option label. */
export function eventGroupLabel(event: Pick<SportEvent, 'league' | 'country'>): string {
  return leagueGroupLabel(event.league, event.country)
}

/**
 * The display label for a stored league-pair key — the league filter's own value needs to stay
 * readable even on a day where that competition has no games (the option list is per-day, but the
 * selection persists across days by design: stepping days while filtered is the point). Returns
 * the key itself when it isn't a pair.
 */
export function leaguePairLabel(key: string): string {
  const idx = key.indexOf(GROUP_SEPARATOR)
  if (idx < 0) return key
  return leagueGroupLabel(key.slice(idx + 1), key.slice(0, idx))
}

/** The distinct countries in the day's list, alphabetical — the country filter's options. Empty
 * names are dropped: an event without a country is reachable through "All countries" only. */
export function countryOptions(events: SportEvent[]): string[] {
  const names = new Set<string>()
  for (const event of events) {
    if (event.country.trim()) names.add(event.country)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * The distinct leagues in the day's list, alphabetical by display label — the league filter's
 * options. `country` narrows the set (a country chosen first is the usual flow); an empty country
 * means every league. Each option carries its `key` — the (country, league) pair the filters
 * match on — so a same-named competition in two countries is two options, not one ambiguous name.
 */
export function leagueOptions(
  events: SportEvent[],
  country: string
): Array<{ key: string; league: string; country: string; label: string }> {
  const byKey = new Map<string, { key: string; league: string; country: string; label: string }>()
  for (const event of events) {
    if (!event.league.trim()) continue
    if (country && event.country !== country) continue
    const key = groupKeyOf(event)
    if (!byKey.has(key)) {
      byKey.set(key, { key, league: event.league, country: event.country, label: eventGroupLabel(event) })
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Apply the two filters ('' = all). The league filter matches the full (country, league) pair —
 * a same-named competition in two countries is two options, not one ambiguous name. Events whose
 * league is empty pass the country filter but never the league filter (there is no option to
 * select for them).
 */
export function filterEvents(events: SportEvent[], league: string, country: string): SportEvent[] {
  return events.filter((event) => {
    if (country && event.country !== country) return false
    if (league && groupKeyOf(event) !== league) return false
    return true
  })
}
