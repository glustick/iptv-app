import { describe, expect, it } from 'vitest'
import { countryOptions, eventGroupLabel, filterEvents, groupEventsByLeague, leagueGroupLabel, leagueOptions, leaguePairLabel } from './sportsGroups'
import type { SportEvent } from './api-sports'

function event(overrides: Partial<SportEvent> & Pick<SportEvent, 'id'>): SportEvent {
  return {
    sportId: 'football',
    kickoff: null,
    league: '',
    country: '',
    round: '',
    homeName: 'Home',
    awayName: 'Away',
    homeScore: null,
    awayScore: null,
    live: false,
    finished: false,
    statusShort: 'NS',
    statusLong: 'Not started',
    ...overrides
  }
}

describe('groupEventsByLeague', () => {
  it('keeps the caller\'s order inside each group', () => {
    const groups = groupEventsByLeague([
      event({ id: 1, league: 'Premier League', country: 'England', homeName: 'A' }),
      event({ id: 2, league: 'Premier League', country: 'England', homeName: 'B' }),
      event({ id: 3, league: 'Premier League', country: 'England', homeName: 'C' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].events.map((e) => e.homeName)).toEqual(['A', 'B', 'C'])
  })

  it('orders groups by first appearance, so a live competition surfaces first', () => {
    // The pane sorts live-first; by the time grouping runs, the live league's row leads.
    const groups = groupEventsByLeague([
      event({ id: 1, league: 'Serie A', country: 'Italy' }),
      event({ id: 2, league: 'Premier League', country: 'England', live: true, statusShort: '2H' })
    ])
    expect(groups.map((g) => g.league)).toEqual(['Serie A', 'Premier League'])
  })

  it('splits same-named competitions in different countries into two groups', () => {
    const groups = groupEventsByLeague([
      event({ id: 1, league: 'Premier League', country: 'England' }),
      event({ id: 2, league: 'Premier League', country: 'Russia' }),
      event({ id: 3, league: 'Premier League', country: 'England' })
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ league: 'Premier League', country: 'England' })
    expect(groups[0].events).toHaveLength(2)
    expect(groups[1]).toMatchObject({ league: 'Premier League', country: 'Russia' })
  })

  it('sinks events without a league into one tail group, and only when present', () => {
    const withNone = groupEventsByLeague([
      event({ id: 1, league: 'Serie A', country: 'Italy' }),
      event({ id: 2, league: '' }),
      event({ id: 3, league: 'Serie A', country: 'Italy', live: true, statusShort: '2H' }),
      event({ id: 4, league: '' })
    ])
    expect(withNone).toHaveLength(2)
    expect(withNone[1]).toMatchObject({ league: '', country: '' })
    expect(withNone[1].events.map((e) => e.id)).toEqual([2, 4])

    expect(groupEventsByLeague([event({ id: 1, league: 'Serie A', country: 'Italy' })])).toHaveLength(1)
  })

  it('counts live games per group for the header badge', () => {
    const groups = groupEventsByLeague([
      event({ id: 1, league: 'Serie A', country: 'Italy', live: true, statusShort: '2H' }),
      event({ id: 2, league: 'Serie A', country: 'Italy' }),
      event({ id: 3, league: 'Premier League', country: 'England' })
    ])
    expect(groups[0].liveCount).toBe(1)
    expect(groups[1].liveCount).toBe(0)
  })
})

describe('labels', () => {
  it('appends the country when the API supplies one', () => {
    expect(leagueGroupLabel('Premier League', 'England')).toBe('Premier League · England')
    expect(leagueGroupLabel('NBA', '')).toBe('NBA')
    expect(eventGroupLabel({ league: 'Ligue 1', country: 'France' })).toBe('Ligue 1 · France')
  })

  it('labels a stored pair key so a filter selection reads on days without its league', () => {
    expect(leaguePairLabel('England\u001fPremier League')).toBe('Premier League · England')
    expect(leaguePairLabel('\u001fNBA')).toBe('NBA')
    expect(leaguePairLabel('not-a-pair')).toBe('not-a-pair')
  })
})

describe('countryOptions', () => {
  it('lists distinct countries alphabetically and drops unnamed ones', () => {
    expect(
      countryOptions([
        event({ id: 1, country: 'England' }),
        event({ id: 2, country: 'Italy' }),
        event({ id: 3, country: 'England' }),
        event({ id: 4, country: '' }),
        event({ id: 5, country: 'France' })
      ])
    ).toEqual(['England', 'France', 'Italy'])
  })
})

describe('leagueOptions', () => {
  const events = [
    event({ id: 1, league: 'Premier League', country: 'England' }),
    event({ id: 2, league: 'Premier League', country: 'Russia' }),
    event({ id: 3, league: 'Serie A', country: 'Italy' }),
    event({ id: 4, league: '' })
  ]

  it('offers every league once, labelled with its country, alphabetically', () => {
    expect(leagueOptions(events, '').map((o) => o.label)).toEqual([
      'Premier League · England',
      'Premier League · Russia',
      'Serie A · Italy'
    ])
  })

  it('narrows to the chosen country', () => {
    expect(leagueOptions(events, 'England').map((o) => o.label)).toEqual(['Premier League · England'])
    expect(leagueOptions(events, 'Germany')).toEqual([])
  })
})

describe('filterEvents', () => {
  const events = [
    event({ id: 1, league: 'Premier League', country: 'England' }),
    event({ id: 2, league: 'Premier League', country: 'Russia' }),
    event({ id: 3, league: 'Serie A', country: 'Italy' }),
    event({ id: 4, league: '', country: '' })
  ]

  it('returns the list untouched when both filters are empty', () => {
    expect(filterEvents(events, '', '')).toHaveLength(4)
  })

  it('filters by country alone, keeping unnamed-country events out', () => {
    expect(filterEvents(events, '', 'England').map((e) => e.id)).toEqual([1])
  })

  it('filters by the league pair, so a same-named competition stays unambiguous', () => {
    const englandKey = 'England\u001fPremier League'
    const russiaKey = 'Russia\u001fPremier League'
    expect(filterEvents(events, englandKey, '').map((e) => e.id)).toEqual([1])
    expect(filterEvents(events, russiaKey, '').map((e) => e.id)).toEqual([2])
  })

  it('combines both filters, and a league never matches a country mismatch', () => {
    expect(filterEvents(events, 'England\u001fPremier League', 'England').map((e) => e.id)).toEqual([1])
    // The country filter excludes the event before the league is even consulted.
    expect(filterEvents(events, 'England\u001fPremier League', 'Russia')).toEqual([])
  })

  it('never matches a no-league event through the league filter', () => {
    expect(filterEvents(events, 'England\u001fPremier League', '')).not.toContain(events[3])
    expect(filterEvents(events, '', '')).toContain(events[3])
  })
})
