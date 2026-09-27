import { describe, it, expect } from 'vitest'
import { normalizeFixture, fetchFixturesForDate, type RawFixture } from './api-football'

function rawFixture(overrides: Partial<RawFixture> = {}): RawFixture {
  return {
    fixture: { id: 215662, date: '2026-09-27T15:00:00Z', status: { short: '1H', long: 'First Half' } },
    goals: { home: 1, away: 0 },
    teams: { home: { name: 'Brentford', logo: '' }, away: { name: 'Chelsea', logo: '' } },
    league: { name: 'Premier League', country: 'England', round: 'Regular Season - 6', season: 2026 },
    ...overrides
  }
}

describe('normalizeFixture', () => {
  it('maps the api-football v3 fixture shape onto the UI model', () => {
    const f = normalizeFixture(rawFixture())
    expect(f.id).toBe(215662)
    expect(f.homeTeam).toBe('Brentford')
    expect(f.awayTeam).toBe('Chelsea')
    expect(f.homeGoals).toBe(1)
    expect(f.awayGoals).toBe(0)
    expect(f.league).toBe('Premier League')
    expect(f.kickoff?.toISOString()).toBe('2026-09-27T15:00:00.000Z')
  })

  it('treats in-play short codes as live (1H/2H/HT/ET/P/LIVE/INT)', () => {
    for (const short of ['1H', '2H', 'HT', 'ET', 'P', 'LIVE', 'INT']) {
      const f = normalizeFixture(rawFixture({ fixture: { id: 1, date: '', status: { short, long: '' } } }))
      expect(f.live, short).toBe(true)
      expect(f.finished, short).toBe(false)
    }
  })

  it('treats terminal short codes as finished (FT/AET/PEN), and only those', () => {
    for (const short of ['FT', 'AET', 'PEN']) {
      const f = normalizeFixture(rawFixture({ fixture: { id: 1, date: '', status: { short, long: '' } } }))
      expect(f.finished, short).toBe(true)
      expect(f.live, short).toBe(false)
    }
    // Not-started and postponed matches are neither — the UI must not badge them.
    for (const short of ['NS', 'TBD', 'PST', 'CANC']) {
      const f = normalizeFixture(rawFixture({ fixture: { id: 1, date: '', status: { short, long: '' } } }))
      expect(f.live, short).toBe(false)
      expect(f.finished, short).toBe(false)
    }
  })

  it('keeps null goals as null (0–0 has not started or is unknown), not coerced to 0', () => {
    const f = normalizeFixture(rawFixture({ goals: { home: null, away: null } }))
    expect(f.homeGoals).toBeNull()
    expect(f.awayGoals).toBeNull()
  })

  it('drops an unparseable kickoff date rather than rendering an Invalid Date', () => {
    const f = normalizeFixture(rawFixture({ fixture: { id: 1, date: 'not-a-date', status: { short: 'NS', long: '' } } }))
    expect(f.kickoff).toBeNull()
  })
})

describe('fetchFixturesForDate', () => {
  it('returns an empty, error-free result without a key and never calls the bridge', async () => {
    let calls = 0
    const bridge = (): Promise<unknown> => {
      calls++
      return Promise.resolve({})
    }
    const result = await fetchFixturesForDate(bridge, '', new Date(2026, 8, 27))
    expect(result.fixtures).toEqual([])
    expect(result.error).toBeNull()
    expect(calls).toBe(0)
  })

  it('requests the local calendar date and normalizes the response array', async () => {
    const seen: string[] = []
    const bridge = (path: string): Promise<unknown> => {
      seen.push(path)
      return Promise.resolve({ response: [rawFixture()] })
    }
    const result = await fetchFixturesForDate(bridge, 'test-key', new Date(2026, 8, 27))
    expect(seen).toEqual(['/fixtures?date=2026-09-27'])
    expect(result.error).toBeNull()
    expect(result.fixtures).toHaveLength(1)
    expect(result.fixtures[0]?.homeTeam).toBe('Brentford')
  })

  it("surfaces api-football's in-band plan/key errors (200 with an errors object)", async () => {
    const bridge = (): Promise<unknown> =>
      Promise.resolve({ errors: { key: 'Invalid API key' } })
    const result = await fetchFixturesForDate(bridge, 'bad-key', new Date())
    expect(result.fixtures).toEqual([])
    expect(result.error).toContain('Invalid API key')
  })

  it('turns a rejected bridge into an error result, not a throw', async () => {
    const bridge = (): Promise<unknown> => Promise.reject(new Error('network down'))
    const result = await fetchFixturesForDate(bridge, 'key', new Date())
    expect(result.fixtures).toEqual([])
    expect(result.error).toBe('network down')
  })
})
