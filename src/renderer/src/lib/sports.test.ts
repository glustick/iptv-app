import { describe, it, expect } from 'vitest'
import {
  buildSportsSchedule,
  classifyCategory,
  cleanCategoryLabel,
  dayKeyOf,
  gamesForDay,
  parseEventName
} from './sports.js'
import type { Category, LiveStream } from './types'

// Fixtures are real channel names from the provider this app is developed against (captured
// live) — the parsing rules exist for these shapes, so the tests pin the actual formats.
const NOW = new Date(2026, 8, 21, 12, 0) // Mon 21 Sep 2026, local noon

function stream(name: string, categoryId: string, num = 1): LiveStream {
  return {
    num,
    name,
    stream_type: 'live',
    stream_id: num,
    stream_icon: '',
    epg_channel_id: null,
    added: '',
    category_id: categoryId,
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

function category(id: string, name: string): Category {
  return { category_id: id, category_name: name, parent_id: 0 }
}

describe('cleanCategoryLabel', () => {
  it('strips the provider prefixes', () => {
    expect(cleanCategoryLabel('Live | English Premier League - EPL ⚽')).toBe('English Premier League - EPL ⚽')
    expect(cleanCategoryLabel('USA | NFL 🏈')).toBe('NFL 🏈')
    expect(cleanCategoryLabel('EN✦ Sky Store Premiere')).toBe('Sky Store Premiere')
    expect(cleanCategoryLabel('UK | Sky Sports')).toBe('Sky Sports')
  })
})

describe('classifyCategory', () => {

  it('maps the real category names to api-football style competitions', () => {
    const leagueOf = (name: string) => {
      const cls = classifyCategory(name)
      return cls?.kind === 'league' ? cls.rule : null
    }
    expect(leagueOf('Live | English Premier League - EPL ⚽')).toMatchObject({
      id: 'premier-league', label: 'Premier League', country: 'England', isFootball: true, venueTz: 'Europe/London'
    })
    expect(leagueOf('Live | Serie A 🇮🇹')?.id).toBe('serie-a')
    expect(leagueOf('USA | NFL 🏈')?.id).toBe('nfl')
    expect(leagueOf('USA | NBA 🏀')?.id).toBe('nba')
    expect(leagueOf('Live | Football Friendly Matches')?.id).toBe('friendlies')
    expect(leagueOf('Fight Club 🥊')?.id).toBe('fighting')
  })

  it('classifies carrier categories as channels-only, not browse groups', () => {
    expect(classifyCategory('UK | Sky Sports')).toEqual({ kind: 'carrier' })
    expect(classifyCategory('USA | ESPN+')).toEqual({ kind: 'carrier' })
    expect(classifyCategory('NFHS Network')).toEqual({ kind: 'carrier' })
    expect(classifyCategory('Sport e calcio ⚽')).toEqual({ kind: 'carrier' })
  })

  it('carries the venue timezone on the league rule', () => {
    const leagueOf = (name: string) => {
      const cls = classifyCategory(name)
      return cls?.kind === 'league' ? cls.rule : null
    }
    expect(leagueOf('USA | MLS Soccer')?.venueTz).toBe('America/New_York')
    expect(leagueOf('Fight Club 🥊')?.venueTz).toBeNull()
  })

  it('returns null for non-sports categories', () => {
    expect(classifyCategory('USA | Movies 🍿')).toBeNull()
    expect(classifyCategory('EN✦ Netflix Series')).toBeNull()
    expect(classifyCategory('24/7 Cartoon')).toBeNull()
  })
})

describe('parseEventName', () => {
  it('parses the "NNN: Home vs Away (carrier) @ time" form', () => {
    const event = parseEventName('Soccer01: Brentford vs Chelsea ( Sky Sports Main Event Feed ) @ 3:00 pm', NOW)
    expect(event).not.toBeNull()
    expect(event?.homeDisplay).toBe('Brentford')
    expect(event?.awayDisplay).toBe('Chelsea')
    // 3:00 pm local (no tz suffix) on the current day.
    expect(event?.kickoff?.getHours()).toBe(15)
  })

  it('retains the venue wall time and tz label for the dual-time display', () => {
    const suffixed = parseEventName("US Open 10: (1) Zverev vs. Khachanov @ Sep 11 2:00PM ET", NOW)
    expect(suffixed?.venueTime).toEqual({ hour: 14, minute: 0, tzLabel: 'ET' })

    const bare = parseEventName('Soccer01: Brentford vs Chelsea @ 3:00 pm', NOW)
    expect(bare?.venueTime).toEqual({ hour: 15, minute: 0, tzLabel: null })

    const noTime = parseEventName('EPL 05: Newcastle United vs. Hull City AFC | Saturday', NOW)
    expect(noTime?.venueTime).toBeNull()
  })

  it('interprets suffix-less wall times in the category hint zone, DST-correct', () => {
    // "15:00" on a UK-quoted feed = 15:00 London. In September that is BST (UTC+1); in the
    // depth of January the same wall time is GMT (UTC+0).
    const summer = parseEventName('EPL 05: Newcastle United vs. Hull City AFC | Sunday, 27 September 2026 15:00', NOW, 'Europe/London')
    expect((summer?.kickoff as Date).toISOString()).toBe('2026-09-27T14:00:00.000Z')
    expect(summer?.venueTime?.hour).toBe(15)
    expect(summer?.venueTime?.tzLabel).toMatch(/^(BST|GMT\+1)$/)

    const winter = parseEventName('EPL 05: Newcastle United vs. Hull City AFC | Friday, 16 January 2026 15:00', NOW, 'Europe/London')
    expect((winter?.kickoff as Date).toISOString()).toBe('2026-01-16T15:00:00.000Z')
    expect(winter?.venueTime?.tzLabel).toMatch(/^(GMT|UTC|GMT\+0)$/)

    // Without a hint the historic reading (already viewer-local) is unchanged.
    const unhinted = parseEventName('EPL 05: Newcastle United vs. Hull City AFC | Sunday, 27 September 2026 15:00', NOW)
    expect(unhinted?.kickoff?.getHours()).toBe(15)
    expect(unhinted?.venueTime?.tzLabel).toBeNull()
  })

  it('parses the "TeamA HH:MM TeamB" form with no separator', () => {
    const event = parseEventName('EPL01: Brentford 20:00 Chelsea', NOW)
    expect(event).not.toBeNull()
    expect(event?.homeDisplay).toBe('Brentford')
    expect(event?.awayDisplay).toBe('Chelsea')
    expect(event?.kickoff?.getHours()).toBe(20)
  })

  it('parses ranked players and a US date with timezone ("US Open")', () => {
    const event = parseEventName("US Open 10: (1) Zverev vs. Khachanov (Men's Semifinals) @ Sep 11 2:00PM ET", NOW)
    expect(event).not.toBeNull()
    expect(event?.homeDisplay).toBe('Zverev')
    expect(event?.awayDisplay).toBe('Khachanov')
    // 2:00PM ET == 18:00Z. The local day depends on this machine's timezone, so assert the
    // instant exactly and derive the expected day bucket from it.
    expect((event?.kickoff as Date).toISOString()).toBe('2026-09-11T18:00:00.000Z')
    expect(dayKeyOf(event?.kickoff as Date)).toBe(dayKeyOf(new Date('2026-09-11T18:00:00.000Z')))
  })

  it('parses day-month names with timezone from the Bar TV form', () => {
    const event = parseEventName('Bar TV 09: NHRL Grand Final - A Grade Ladies League Tag - Central Newcastle v Waratah-Mayfield @ Sep 12 9:15AM AEST', NOW)
    expect(event).not.toBeNull()
    expect(event?.homeDisplay).toBe('Central Newcastle')
    expect(event?.awayDisplay).toBe('Waratah-Mayfield')
    expect(event?.kickoff?.getUTCDate()).toBe(11) // 9:15AM AEST == 11:15PM UTC prev day
  })

  it('parses the pipe form with a full weekday date', () => {
    const event = parseEventName('PSF 03 | 16:00 Newcastle United vs Strasbourg', NOW)
    expect(event).not.toBeNull()
    expect(event?.homeDisplay).toBe('Newcastle United')
    expect(event?.awayDisplay).toBe('Strasbourg')
    expect(event?.kickoff?.getHours()).toBe(16)
  })

  it('parses the weekday-full-date pipe form (EPL 05ⓧ)', () => {
    const event = parseEventName('EPL 05ⓧ: Newcastle United vs. Hull City AFC | Saturday, 19 September 2026 15:00', NOW)
    expect(event).not.toBeNull()
    expect(event?.homeDisplay).toBe('Newcastle United')
    expect(event?.awayDisplay).toBe('Hull City AFC')
    expect(dayKeyOf(event?.kickoff as Date)).toBe('2026-09-19')
  })

  it('parses the League Cup form with GMT-1 offset', () => {
    const event = parseEventName('TOD EN 19: League Cup: Sunderland vs Hull City @ 8 Sep 07:25 PM GMT-1', NOW)
    expect(event).not.toBeNull()
    expect(event?.homeDisplay).toBe('Sunderland')
    expect(event?.awayDisplay).toBe('Hull City')
    // 07:25 PM GMT-1 == 20:25Z on Sep 8.
    expect(event?.kickoff?.getUTCDate()).toBe(8)
    expect(event?.kickoff?.getUTCHours()).toBe(20)
  })

  it('returns null for carrier channels and non-events', () => {
    expect(parseEventName('668 Sky Sports Main Event UHD', NOW)).toBeNull()
    expect(parseEventName('NRL : NEWCASTLE KNIGHTS', NOW)).toBeNull()
    expect(parseEventName('US Open 14: NO EVENT', NOW)).toBeNull()
    expect(parseEventName('US: Big Brother Live Feeds (Camera 1)', NOW)).toBeNull()
  })

  it('normalizes club suffixes in the match key but keeps display names', () => {
    const withSuffix = parseEventName('EPL 05ⓧ: Newcastle United vs. Hull City AFC | Saturday, 19 September 2026 15:00', NOW)
    const without = parseEventName('EPL 06ⓧ: Newcastle United vs. Hull City | Saturday, 19 September 2026 15:00', NOW)
    expect(withSuffix?.homeKey).toBe(without?.homeKey)
    expect(withSuffix?.awayKey).toBe(without?.awayKey)
    expect(withSuffix?.awayDisplay).toBe('Hull City AFC')
  })
})

describe('buildSportsSchedule', () => {
  const categories = [
    category('100', 'Live | English Premier League - EPL ⚽'),
    category('101', 'Live | EPL Backup'),
    category('200', 'UK | Sky Sports'),
    category('300', 'USA | Movies 🍿')
  ]

  function schedule(): ReturnType<typeof buildSportsSchedule> {
    const streams = [
      // The same fixture under three categories — the duplication the drill-down collapses.
      stream('Soccer01: Brentford vs Chelsea ( Sky Sports Main Event Feed ) @ 3:00 pm', '100', 11),
      stream('Soccer02: Brentford vs Chelsea ( Sky Sports Premier League Feed ) @ 3:00 pm', '100', 12),
      stream('EPL-B1: Brentford vs Chelsea (Backup) @ 3:00 pm', '101', 21),
      // A different football game, other day.
      stream('EPL 05ⓧ: Newcastle United vs. Hull City AFC | Saturday, 19 September 2026 15:00', '100', 31),
      // A carrier channel — reachable via the group's channel list, never a game.
      stream('401 Sky Sports Main Event HD', '200', 41),
      // A non-sports category — invisible to Sports entirely.
      stream('Some Movie', '300', 51)
    ]
    return buildSportsSchedule(streams, categories, NOW)
  }

  it('groups by competition with football leagues first, and lists carrier channels flat', () => {
    const s = schedule()
    expect(s.leagues.map((l) => l.id)).toEqual(['premier-league'])
    expect(s.leagues[0].label).toBe('Premier League')
    expect(s.leagues[0].country).toBe('England')
    expect(s.leagues[0].categoryIds).toEqual(['100', '101'])
    expect(s.channels.map((c) => c.name)).toEqual(['401 Sky Sports Main Event HD'])
  })

  it('collapses one fixture across categories into a single game with all its feeds', () => {
    const { gamesByLeague } = schedule()
    const games = gamesByLeague['premier-league'] ?? []
    const brentford = games.find((g) => g.homeDisplay === 'Brentford')
    expect(brentford).toBeDefined()
    expect(brentford?.leagueId).toBe('premier-league')
    expect(brentford?.channels).toHaveLength(3)
    expect(brentford?.channels.map((c) => c.stream_id)).toEqual([11, 12, 21])
    expect(brentford?.dayKey).toBe(dayKeyOf(NOW))
  })

  it('buckets games by their kickoff day and sorts earliest first', () => {
    const { gamesByLeague } = schedule()
    const games = gamesByLeague['premier-league'] ?? []
    expect(games).toHaveLength(2)
    const sep19 = gamesForDay(games, '2026-09-19')
    expect(sep19).toHaveLength(1)
    expect(sep19[0].homeDisplay).toBe('Newcastle United')
    expect(gamesForDay(games, '2026-09-22')).toHaveLength(0)
  })

  it('keeps unscheduled events in a null-day bucket instead of dropping them', () => {
    const streams = [stream('TOD 55: Union Berlin vs Mainz 05 (time TBD)', '100', 61)]
    const { gamesByLeague } = buildSportsSchedule(streams, categories, NOW)
    const games = gamesByLeague['premier-league'] ?? []
    expect(games).toHaveLength(1)
    expect(games[0].dayKey).toBeNull()
    expect(games[0].channels).toHaveLength(1)
  })
})
