// Unit tests for lib/api-sports.ts — the api-football.com family's per-sport module. The payload
// shapes pinned here follow the module's own live observations (2026-09-29): basketball/baseball/
// hockey/handball/volleyball answer /games with teams+scores+status.short; NFL answers nested
// game.date.timestamp; NBA v2 uses visitors/home and date.start; AFL nests game.id and
// scores.*.score; MMA uses fighters; F1 races are season-scoped.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SPORT_ID,
  SPORT_SOURCES,
  fetchSportEventsForDate,
  normalizeSportEvents,
  sportEventFromFootballFixture,
  sportPathFor,
  sportSourceById,
  type SportSource
} from './api-sports'

function byId(id: string): SportSource {
  const source = sportSourceById(id)
  if (!source) throw new Error(`test fixture is missing sport source "${id}"`)
  return source
}

/** One generic /games entry, shaped like the live basketball responses. */
function gamesEntry(short: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 301,
    date: '2026-09-29T18:30:00+00:00',
    status: { long: 'Quarter 1', short },
    teams: { home: { name: 'Los Angeles Lakers' }, away: { name: 'Boston Celtics' } },
    scores: { home: { total: 22 }, away: { total: 18 } },
    league: { name: 'NBA', country: { name: 'USA' } },
    ...overrides
  }
}

describe('SPORT_SOURCES', () => {
  it("is the platform's own category list — football first, the rest alphabetical", () => {
    expect(SPORT_SOURCES.map((s) => s.id)).toEqual([
      'football',
      'afl',
      'baseball',
      'basketball',
      'formula-1',
      'handball',
      'hockey',
      'mma',
      'nba',
      'nfl',
      'rugby',
      'volleyball'
    ])
    expect(SPORT_SOURCES[0]?.label).toBe('Football')
    expect(DEFAULT_SPORT_ID).toBe('football')
    for (const source of SPORT_SOURCES) expect(source.host).toMatch(/^v\d+\.\w[\w.-]*\.api-sports\.io$/)
  })

  it('resolves by id, case-sensitively, and has no entry for sports outside the platform', () => {
    expect(byId('nba').host).toBe('v2.nba.api-sports.io')
    expect(byId('nfl').host).toBe('v1.american-football.api-sports.io')
    expect(byId('formula-1').kind).toBe('races')
    expect(sportSourceById('cricket')).toBeNull()
    expect(sportSourceById('Football')).toBeNull()
  })
})

describe('sportPathFor', () => {
  const day = new Date(2026, 8, 29)

  it('queries day-shaped sports by date and Formula-1 by season', () => {
    expect(sportPathFor(byId('football'), day)).toBe('/fixtures?date=2026-09-29')
    expect(sportPathFor(byId('basketball'), day)).toBe('/games?date=2026-09-29')
    expect(sportPathFor(byId('mma'), day)).toBe('/fights?date=2026-09-29')
    expect(sportPathFor(byId('formula-1'), day)).toBe('/races?season=2026')
  })
})

describe('normalizeSportEvents', () => {
  it('normalizes the /games family (live basketball shape), scores and status included', () => {
    const [event] = normalizeSportEvents(byId('basketball'), { response: [gamesEntry('Q1')] })
    expect(event).toMatchObject({
      id: 301,
      sportId: 'basketball',
      league: 'NBA',
      country: 'USA',
      homeName: 'Los Angeles Lakers',
      awayName: 'Boston Celtics',
      homeScore: 22,
      awayScore: 18,
      live: true,
      finished: false,
      statusShort: 'Q1',
      statusLong: 'Quarter 1'
    })
    expect(event?.kickoff?.toISOString()).toBe('2026-09-29T18:30:00.000Z')
  })

  it("treats each sport's in-play codes as live and its terminal codes as finished, only", () => {
    const forSport = (sport: string, short: string): ReturnType<typeof normalizeSportEvents>[number] | undefined =>
      normalizeSportEvents(byId(sport), { response: [gamesEntry(short)] })[0]
    expect(forSport('hockey', 'P2')?.live).toBe(true)
    expect(forSport('volleyball', 'S2')?.live).toBe(true)
    expect(forSport('handball', 'H2')?.live).toBe(true)
    expect(forSport('basketball', 'OT')?.live).toBe(true)
    expect(forSport('baseball', 'FT')?.finished).toBe(true)
    // Not-started and postponed rows badge neither.
    expect(forSport('hockey', 'NS')?.live).toBe(false)
    expect(forSport('hockey', 'NS')?.finished).toBe(false)
    expect(forSport('hockey', 'PST')?.live).toBe(false)
  })

  it("reads american football's nested game.date.timestamp and score nesting", () => {
    const ts = Math.floor(Date.UTC(2026, 8, 29, 18, 30) / 1000)
    const payload = {
      response: [
        {
          game: {
            id: 71,
            date: { timestamp: ts, date: '2026-09-29', time: '18:30' },
            status: { short: 'Q3', long: 'Quarter 3' }
          },
          teams: { home: { name: 'Chiefs' }, away: { name: 'Raiders' } },
          scores: { home: { total: 21 }, away: { total: 10 } },
          league: { name: 'NFL' },
          country: { name: 'USA' }
        }
      ]
    }
    const [event] = normalizeSportEvents(byId('nfl'), payload)
    expect(event?.id).toBe(71)
    expect(event?.kickoff?.toISOString()).toBe('2026-09-29T18:30:00.000Z')
    expect(event?.homeScore).toBe(21)
    expect(event?.live).toBe(true)
  })

  it("reads NBA v2's visitors/home naming, date.start and period status", () => {
    const payload = {
      response: [
        {
          id: 402,
          date: { start: '2026-10-22T23:00:00Z' },
          status: { long: 'Finished', short: '3' },
          teams: { visitors: { name: 'Golden State Warriors' }, home: { name: 'Phoenix Suns' } },
          scores: { visitors: { points: 101 }, home: { points: 110 } }
        }
      ]
    }
    const [event] = normalizeSportEvents(byId('nba'), payload)
    expect(event?.homeName).toBe('Phoenix Suns')
    expect(event?.awayName).toBe('Golden State Warriors')
    expect(event?.homeScore).toBe(110)
    // The away score rides under `visitors` on NBA v2 — reading only `scores.away` returned null.
    expect(event?.awayScore).toBe(101)
    expect(event?.finished).toBe(true)
    expect(event?.live).toBe(false)
    expect(event?.kickoff?.toISOString()).toBe('2026-10-22T23:00:00.000Z')
  })

  it("treats NBA's running period numbers as live", () => {
    const payload = {
      response: [
        {
          id: 403,
          date: { start: '2026-10-22T23:00:00Z' },
          status: { long: 'Quarter 3', short: '3' },
          teams: { visitors: { name: 'A' }, home: { name: 'B' } },
          scores: { visitors: { points: 60 }, home: { points: 58 } }
        }
      ]
    }
    expect(normalizeSportEvents(byId('nba'), payload)[0]?.live).toBe(true)
  })

  it("reads AFL's game.id nesting, nested game.date, and score field", () => {
    const payload = {
      response: [
        {
          game: { id: 88, date: '2026-09-29T09:00:00Z', status: { short: 'Q2' } },
          teams: { home: { name: 'Magpies' }, away: { name: 'Blues' } },
          scores: { home: { score: 45, goals: 6, behinds: 9 }, away: { score: 30 } }
        }
      ]
    }
    const [event] = normalizeSportEvents(byId('afl'), payload)
    expect(event?.id).toBe(88)
    expect(event?.kickoff?.toISOString()).toBe('2026-09-29T09:00:00.000Z')
    expect(event?.homeScore).toBe(45)
    expect(event?.awayScore).toBe(30)
  })

  it('normalizes MMA fights (fighters.first/second, slug, category)', () => {
    const payload = {
      response: [
        {
          id: 5,
          date: '2026-10-03T22:00:00Z',
          slug: 'ufc-fight-night-vegas',
          status: { short: 'NS', long: 'Not Started' },
          fighters: { first: { name: 'Fighter One' }, second: { name: 'Fighter Two' } },
          category: 'Lightweight'
        }
      ]
    }
    const [event] = normalizeSportEvents(byId('mma'), payload)
    expect(event).toMatchObject({
      homeName: 'Fighter One',
      awayName: 'Fighter Two',
      league: 'ufc-fight-night-vegas',
      round: 'Lightweight',
      live: false,
      finished: false
    })
  })

  it('normalizes Formula-1 races (competition name/location, status word)', () => {
    const payload = {
      response: [
        {
          id: 9,
          date: '2026-09-27T12:00:00Z',
          status: 'Completed',
          type: 'Race',
          competition: { name: 'Singapore Grand Prix', location: { country: 'Singapore' } }
        }
      ]
    }
    const [event] = normalizeSportEvents(byId('formula-1'), payload)
    expect(event).toMatchObject({
      league: 'Singapore Grand Prix',
      country: 'Singapore',
      round: 'Race',
      homeName: 'Singapore Grand Prix',
      awayName: '',
      finished: true,
      live: false
    })
    expect(event?.kickoff?.toISOString()).toBe('2026-09-27T12:00:00.000Z')
  })

  it('drops rows with no usable identity rather than rendering blanks', () => {
    expect(normalizeSportEvents(byId('basketball'), { response: [gamesEntry('Q1', { id: 0 })] })).toEqual([])
    expect(normalizeSportEvents(byId('basketball'), { response: [{ teams: {} }] })).toEqual([])
    expect(normalizeSportEvents(byId('basketball'), { response: 'not an array' })).toEqual([])
    expect(normalizeSportEvents(byId('basketball'), null)).toEqual([])
  })

  it('deliberately never handles football — its path is lib/api-football.ts', () => {
    expect(normalizeSportEvents(byId('football'), { response: [gamesEntry('1H')] })).toEqual([])
  })
})

describe('sportEventFromFootballFixture', () => {
  it("renders the football fixtures' shape as the family's unified event row", () => {
    const event = sportEventFromFootballFixture({
      id: 215662,
      kickoff: new Date('2026-09-27T15:00:00Z'),
      league: 'Premier League',
      country: 'England',
      round: 'Regular Season - 6',
      homeTeam: 'Brentford',
      awayTeam: 'Chelsea',
      homeGoals: 1,
      awayGoals: 0,
      live: false,
      finished: true,
      statusLong: 'Match Finished'
    })
    expect(event).toMatchObject({
      id: 215662,
      sportId: 'football',
      league: 'Premier League',
      homeName: 'Brentford',
      awayName: 'Chelsea',
      homeScore: 1,
      awayScore: 0,
      finished: true,
      live: false,
      statusLong: 'Match Finished'
    })
  })
})

describe('fetchSportEventsForDate', () => {
  it('returns an empty, error-free result without a key and never calls the bridge', async () => {
    let calls = 0
    const bridge = (): Promise<unknown> => {
      calls++
      return Promise.resolve({})
    }
    const result = await fetchSportEventsForDate(bridge, byId('basketball'), '', new Date(2026, 8, 29))
    expect(result).toEqual({ events: [], error: null })
    expect(calls).toBe(0)
  })

  it('skips football — its request path and cache live in lib/api-football.ts', async () => {
    let calls = 0
    const bridge = (): Promise<unknown> => {
      calls++
      return Promise.resolve({})
    }
    const result = await fetchSportEventsForDate(bridge, byId('football'), 'key', new Date(2026, 8, 29))
    expect(result).toEqual({ events: [], error: null })
    expect(calls).toBe(0)
  })

  it('requests the sport id, day path and key, and normalizes the events', async () => {
    const seen: Array<[string, string, string]> = []
    const bridge = (sportId: string, path: string, key: string): Promise<unknown> => {
      seen.push([sportId, path, key])
      return Promise.resolve({ response: [gamesEntry('Q1')] })
    }
    const result = await fetchSportEventsForDate(bridge, byId('basketball'), 'test-key', new Date(2026, 8, 29))
    expect(seen).toEqual([['basketball', '/games?date=2026-09-29', 'test-key']])
    expect(result.error).toBeNull()
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.homeName).toBe('Los Angeles Lakers')
  })

  it("surfaces the platform's in-band plan errors with the sport's label", async () => {
    const bridge = (): Promise<unknown> =>
      Promise.resolve({
        response: [],
        errors: { plan: 'Free plans do not have access to this date. Subscribe to gain access.' }
      })
    const result = await fetchSportEventsForDate(bridge, byId('basketball'), 'key', new Date())
    expect(result.events).toEqual([])
    expect(result.error).toBe('Basketball: Free plans do not have access to this date. Subscribe to gain access.')
  })

  it("turns a rejected bridge into an error result, stripping Electron's IPC prefix", async () => {
    const bridge = (): Promise<unknown> =>
      Promise.reject(
        new Error("Error invoking remote method 'api-sports:fetch': Error: API-Sports request failed (403)")
      )
    const result = await fetchSportEventsForDate(bridge, byId('rugby'), 'key', new Date())
    expect(result.events).toEqual([])
    expect(result.error).toBe('API-Sports request failed (403)')
  })

  it("filters a season's races down to the selected viewer-local day", async () => {
    const response = [
      {
        id: 1,
        date: '2026-09-27T12:00:00Z',
        status: 'Completed',
        type: 'Race',
        competition: { name: 'Singapore Grand Prix', location: { country: 'Singapore' } }
      },
      {
        id: 2,
        date: '2026-10-04T12:00:00Z',
        status: 'Scheduled',
        type: 'Race',
        competition: { name: 'Japanese Grand Prix', location: { country: 'Japan' } }
      }
    ]
    const bridge = (): Promise<unknown> => Promise.resolve({ response })
    const result = await fetchSportEventsForDate(bridge, byId('formula-1'), 'key', new Date(2026, 8, 27))
    expect(result.error).toBeNull()
    expect(result.events.map((event) => event.id)).toEqual([1])
  })
})
