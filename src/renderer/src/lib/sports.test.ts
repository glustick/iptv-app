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
  it('maps the real category names to sports, football included', () => {
    expect(classifyCategory('Live | English Premier League - EPL ⚽')).toEqual({ id: 'football', label: 'Football / Soccer' })
    expect(classifyCategory('Live | EPL Teams')).toEqual({ id: 'football', label: 'Football / Soccer' })
    expect(classifyCategory('Live | Serie A 🇮🇹')).toEqual({ id: 'football', label: 'Football / Soccer' })
    expect(classifyCategory('USA | NFL 🏈')).toEqual({ id: 'american-football', label: 'American Football' })
    expect(classifyCategory('USA | NBA 🏀')).toEqual({ id: 'basketball', label: 'Basketball' })
    expect(classifyCategory('Fight Club 🥊')).toEqual({ id: 'fighting', label: 'Fighting' })
    expect(classifyCategory('Live | UFC Fight Pass')).toEqual({ id: 'fighting', label: 'Fighting' })
  })

  it('maps carrier categories to their own browse group', () => {
    expect(classifyCategory('UK | Sky Sports')).toEqual({ id: 'carrier:sky sports', label: 'Sky Sports' })
    expect(classifyCategory('USA | ESPN+')).toEqual({ id: 'carrier:espn+', label: 'ESPN+' })
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

  it('pins Football / Soccer first and excludes non-sports categories', () => {
    const { sports } = schedule()
    expect(sports[0].id).toBe('football')
    expect(sports.map((s) => s.id)).toContain('carrier:sky sports')
    expect(sports.map((s) => s.id)).not.toContain('carrier:usa | movies 🍿')
    expect(sports[0].categoryIds).toEqual(['100', '101'])
  })

  it('collapses one fixture across categories into a single game with all its feeds', () => {
    const { gamesBySport } = schedule()
    const games = gamesBySport['football'] ?? []
    const brentford = games.find((g) => g.homeDisplay === 'Brentford')
    expect(brentford).toBeDefined()
    expect(brentford?.channels).toHaveLength(3)
    expect(brentford?.channels.map((c) => c.stream_id)).toEqual([11, 12, 21])
    expect(brentford?.dayKey).toBe(dayKeyOf(NOW))
  })

  it('buckets games by their kickoff day and sorts earliest first', () => {
    const { gamesBySport } = schedule()
    const games = gamesBySport['football'] ?? []
    expect(games).toHaveLength(2)
    const sep19 = gamesForDay(games, '2026-09-19')
    expect(sep19).toHaveLength(1)
    expect(sep19[0].homeDisplay).toBe('Newcastle United')
    expect(gamesForDay(games, '2026-09-22')).toHaveLength(0)
  })

  it('keeps unscheduled events in a null-day bucket instead of dropping them', () => {
    const streams = [stream('TOD 55: Union Berlin vs Mainz 05 (time TBD)', '100', 61)]
    const { gamesBySport } = buildSportsSchedule(streams, categories, NOW)
    const games = gamesBySport['football'] ?? []
    expect(games).toHaveLength(1)
    expect(games[0].dayKey).toBeNull()
    expect(games[0].channels).toHaveLength(1)
  })
})
