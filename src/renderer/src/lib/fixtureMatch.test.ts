// Unit tests for lib/fixtureMatch.ts — the conservative join between the API's day list and the
// provider's own event-named channels. A wrong channel list under a selected game is worse than
// an empty one, so the rules are pinned here: exact wins first, a loose match only when exactly
// one event can claim a game, and generic halves ('united', 'city') can never carry a match alone.

import { describe, it, expect } from 'vitest'
import {
  channelsMentioningTeams,
  eventMatchKey,
  indexEventsByMatch,
  loosePairMatches,
  matchEventsToGames,
  sideLooselyMatches
} from './fixtureMatch'
import type { SportEvent } from './api-sports'
import type { LiveStream } from './types'

function event(home: string, away: string, id = 1, overrides: Partial<SportEvent> = {}): SportEvent {
  return {
    id,
    sportId: 'football',
    kickoff: null,
    league: '',
    country: '',
    round: '',
    homeName: home,
    awayName: away,
    homeScore: null,
    awayScore: null,
    live: false,
    finished: false,
    statusShort: '',
    statusLong: '',
    ...overrides
  }
}

function channel(name: string, num: number): LiveStream {
  return {
    num,
    name,
    stream_type: 'live',
    stream_id: num,
    stream_icon: '',
    epg_channel_id: null,
    added: '',
    category_id: 'sports',
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

describe('eventMatchKey', () => {
  it('is order-independent and runs both names through the provider parser', () => {
    expect(eventMatchKey({ homeName: 'Newcastle United', awayName: 'Sunderland' })).toBe(
      eventMatchKey({ homeName: 'Sunderland', awayName: 'Newcastle United' })
    )
    expect(eventMatchKey({ homeName: 'Newcastle United', awayName: 'Sunderland' })).toBe(
      'newcastle united vs sunderland'
    )
  })
})

describe('indexEventsByMatch', () => {
  it('keeps the live/finished entry when two rows carry the same match', () => {
    const scheduled = event('Arsenal', 'Chelsea', 1)
    const live = event('Arsenal', 'Chelsea', 2, { live: true, homeScore: 1, awayScore: 0 })
    const map = indexEventsByMatch([scheduled, live])
    expect(map.size).toBe(1)
    expect(map.get('arsenal vs chelsea')?.id).toBe(2)
  })

  it('keeps a live entry when a scheduled row arrives after it', () => {
    const live = event('Arsenal', 'Chelsea', 2, { live: true })
    const scheduled = event('Arsenal', 'Chelsea', 1)
    expect(indexEventsByMatch([live, scheduled]).get('arsenal vs chelsea')?.id).toBe(2)
  })

  it('ignores events with no usable team key', () => {
    expect(indexEventsByMatch([event('', '', 9)]).size).toBe(0)
  })
})

describe('sideLooselyMatches', () => {
  it('accepts token-subset clubs, both directions', () => {
    expect(sideLooselyMatches('newcastle', 'newcastle united')).toBe(true)
    expect(sideLooselyMatches('newcastle united', 'newcastle')).toBe(true)
    expect(sideLooselyMatches('brighton', 'brighton hove albion')).toBe(true)
  })

  it('never lets a generic half carry a match alone', () => {
    expect(sideLooselyMatches('united', 'leeds united')).toBe(false)
    expect(sideLooselyMatches('city', 'manchester city')).toBe(false)
    expect(sideLooselyMatches('real', 'real madrid')).toBe(false)
  })

  it('rejects empty sides and requires a real word in the shorter one', () => {
    expect(sideLooselyMatches('', 'liverpool')).toBe(false)
    expect(sideLooselyMatches('liverpool', '')).toBe(false)
    expect(sideLooselyMatches('fc', 'liverpool fc')).toBe(false)
  })
})

describe('loosePairMatches', () => {
  it('matches a pair in either home/away order', () => {
    expect(loosePairMatches('newcastle vs sunderland', 'newcastle united vs sunderland')).toBe(true)
    expect(loosePairMatches('sunderland vs newcastle', 'newcastle united vs sunderland')).toBe(true)
    expect(loosePairMatches('newcastle vs sunderland', 'newcastle vs middlesbrough')).toBe(false)
  })
})

describe('matchEventsToGames', () => {
  it('pairs exact matches first, then a single-candidate loose match', () => {
    const events = [event('Arsenal', 'Chelsea', 1), event('Newcastle United', 'Sunderland', 2)]
    const games = [
      { key: 'g1', pairKey: 'arsenal vs chelsea' },
      { key: 'g2', pairKey: 'newcastle vs sunderland' }
    ]
    const { byGame, matchedEventIds } = matchEventsToGames(events, games)
    expect(byGame.get('g1')?.id).toBe(1)
    expect(byGame.get('g2')?.id).toBe(2)
    expect([...matchedEventIds].sort()).toEqual([1, 2])
  })

  it('refuses an ambiguous loose match — an empty list beats a wrong one', () => {
    const events = [
      event('Newcastle United', 'Sunderland', 1),
      event('Newcastle U21', 'Sunderland', 2)
    ]
    const games = [{ key: 'g1', pairKey: 'newcastle vs sunderland' }]
    expect(matchEventsToGames(events, games).byGame.size).toBe(0)
  })

  it('does not reuse an event that already claimed a game', () => {
    const events = [event('Arsenal', 'Chelsea', 1)]
    const games = [
      { key: 'g1', pairKey: 'arsenal vs chelsea' },
      { key: 'g2', pairKey: 'arsenal vs chelsea women' }
    ]
    const { byGame } = matchEventsToGames(events, games)
    expect(byGame.has('g1')).toBe(true)
    expect(byGame.has('g2')).toBe(false)
  })
})

describe('channelsMentioningTeams', () => {
  it('ranks channels by how many team words the name contains', () => {
    const channels = [channel('Celtics TV', 1), channel('Lakers vs Celtics HD', 2), channel('Lakers Feed', 3)]
    const hits = channelsMentioningTeams(channels, 'Los Angeles Lakers', 'Boston Celtics')
    expect(hits.map((c) => c.name)).toEqual(['Lakers vs Celtics HD', 'Celtics TV', 'Lakers Feed'])
  })

  it('never lets short or generic team words carry a hit on their own', () => {
    expect(channelsMentioningTeams([channel('PSG TV', 1)], 'PSG', 'Marseille')).toEqual([])
  })

  it('returns nothing when no channel name contains a team word', () => {
    expect(channelsMentioningTeams([channel('Sky Sports News', 1)], 'Arsenal', 'Chelsea')).toEqual([])
  })
})
