import { describe, expect, it } from 'vitest'
import { buildGuideSearchIndex, searchGuideProgrammes } from './guideSearch'
import type { EpgData, EpgProgramme } from './epg'
import type { LiveStream } from './types'

function stream(id: number, name: string, epgChannelId: string | null = null): LiveStream {
  return {
    num: id,
    name,
    stream_type: 'live',
    stream_id: id,
    stream_icon: '',
    epg_channel_id: epgChannelId,
    added: '',
    category_id: '1',
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

function programme(channelId: string, title: string, startMs: number, stopMs: number): EpgProgramme {
  return { channelId, title, start: new Date(startMs), stop: new Date(stopMs) }
}

function guide(channels: Array<[string, string]>, programmesByChannel: Record<string, EpgProgramme[]>): EpgData {
  return {
    channels: new Map(channels.map(([id, displayName]) => [id, { id, displayName }])),
    programmesByChannel: new Map(Object.entries(programmesByChannel))
  }
}

const NOW = new Date('2026-11-09T12:00:00Z')
const HOUR = 3_600_000

describe('buildGuideSearchIndex + searchGuideProgrammes', () => {
  const liveStreams = [
    stream(1, 'One HD', 'one.hd'),
    // Only the relaxed tier can join this one ("101 Two HD" → the guide's "Two").
    stream(2, '101 Two HD')
  ]

  it('finds an on-now programme and joins it back to the provider channel', () => {
    const index = buildGuideSearchIndex({
      liveStreams,
      epgSources: [
        guide(
          [
            ['one.hd', 'One HD'],
            ['two.uk', 'Two']
          ],
          {
            'one.hd': [programme('one.hd', 'Ones Show', NOW.getTime() - HOUR, NOW.getTime() + HOUR)],
            'two.uk': [programme('two.uk', "Two's Show", NOW.getTime() - HOUR, NOW.getTime() + HOUR)]
          }
        )
      ],
      epgSourceLabels: ['provider'],
      hiddenSourceUrls: [],
      manualMappings: [],
      primaryPlaylistId: null,
      now: NOW
    })
    const hits = searchGuideProgrammes(index, "two's show", NOW)
    expect(hits).toHaveLength(1)
    expect(hits[0].program.title).toBe("Two's Show")
    expect(hits[0].stream.stream_id).toBe(2)
    expect(hits[0].onAir).toBe(true)
  })

  it('ranks on-air first, then soonest to start', () => {
    const index = buildGuideSearchIndex({
      liveStreams: [stream(1, 'News 24', 'news.24')],
      epgSources: [
        guide(
          [['news.24', 'News 24']],
          {
            'news.24': [
              programme('news.24', 'News at Six', NOW.getTime() - HOUR, NOW.getTime() + HOUR),
              programme('news.24', 'News at Nine', NOW.getTime() + 3 * HOUR, NOW.getTime() + 4 * HOUR),
              programme('news.24', 'News at Seven', NOW.getTime() + HOUR, NOW.getTime() + 2 * HOUR)
            ]
          }
        )
      ],
      epgSourceLabels: ['provider'],
      hiddenSourceUrls: [],
      manualMappings: [],
      primaryPlaylistId: null,
      now: NOW
    })
    const hits = searchGuideProgrammes(index, 'news', NOW)
    expect(hits.map((h) => h.program.title)).toEqual(['News at Six', 'News at Seven', 'News at Nine'])
    expect(hits[0].onAir).toBe(true)
    expect(hits[1].onAir).toBe(false)
    expect(hits[2].onAir).toBe(false)
  })

  it('drops programmes that have already ended, and needs two characters like the palette', () => {
    const index = buildGuideSearchIndex({
      liveStreams: [stream(1, 'One HD', 'one.hd')],
      epgSources: [
        guide([['one.hd', 'One HD']], {
          'one.hd': [
            programme('one.hd', 'Finished Show', NOW.getTime() - 2 * HOUR, NOW.getTime() - HOUR),
            programme('one.hd', 'Future Show', NOW.getTime() + HOUR, NOW.getTime() + 2 * HOUR)
          ]
        })
      ],
      epgSourceLabels: ['provider'],
      hiddenSourceUrls: [],
      manualMappings: [],
      primaryPlaylistId: null,
      now: NOW
    })
    expect(searchGuideProgrammes(index, 'finished', NOW)).toEqual([])
    expect(searchGuideProgrammes(index, 'future', NOW).map((h) => h.program.title)).toEqual(['Future Show'])
    expect(searchGuideProgrammes(index, 'f', NOW)).toEqual([])
  })

  it('dedupes across sources by priority: the first source with programmes owns the channel', () => {
    const provider = guide([['one.hd', 'One HD']], {
      'one.hd': [programme('one.hd', 'Provider Listing', NOW.getTime() - HOUR, NOW.getTime() + HOUR)]
    })
    const custom = guide([['one.hd', 'One HD']], {
      'one.hd': [programme('one.hd', 'Custom Listing', NOW.getTime() - HOUR, NOW.getTime() + HOUR)]
    })
    const index = buildGuideSearchIndex({
      liveStreams: [stream(1, 'One HD', 'one.hd')],
      epgSources: [provider, custom],
      epgSourceLabels: ['provider', 'custom.xml'],
      hiddenSourceUrls: [],
      manualMappings: [],
      primaryPlaylistId: null,
      now: NOW
    })
    expect(searchGuideProgrammes(index, 'listing', NOW).map((h) => h.program.title)).toEqual(['Provider Listing'])
  })

  it('skips a hidden source entirely, and honours a manual mapping', () => {
    const custom = guide(
      [
        ['custom.news', 'Somewhere Else'],
        ['custom.mapped', 'Mapped Guide Channel']
      ],
      {
        'custom.news': [programme('custom.news', 'Elsewhere Show', NOW.getTime() - HOUR, NOW.getTime() + HOUR)],
        'custom.mapped': [programme('custom.mapped', 'Mapped Show', NOW.getTime() - HOUR, NOW.getTime() + HOUR)]
      }
    )
    const hidden = buildGuideSearchIndex(
      {
        liveStreams: [stream(3, 'Somewhere Else')],
        epgSources: [custom],
        epgSourceLabels: ['custom.xml'],
        hiddenSourceUrls: ['custom.xml'],
        manualMappings: [],
        primaryPlaylistId: null,
        now: NOW
      }
    )
    expect(searchGuideProgrammes(hidden, 'elsewhere', NOW)).toEqual([])

    const mapped = buildGuideSearchIndex({
      liveStreams: [stream(3, 'Unmatched Channel')],
      epgSources: [custom],
      epgSourceLabels: ['custom.xml'],
      hiddenSourceUrls: [],
      manualMappings: [{ sourceUrl: 'custom.xml', guideChannelId: 'custom.mapped', streamId: 3 }],
      primaryPlaylistId: null,
      now: NOW
    })
    expect(searchGuideProgrammes(mapped, 'mapped', NOW).map((h) => h.stream.stream_id)).toEqual([3])
  })

  it('folds accents and case in both the query and the title', () => {
    const index = buildGuideSearchIndex({
      liveStreams: [stream(1, 'Café TV', 'cafe.tv')],
      epgSources: [guide([['cafe.tv', 'Café TV']], {
        'cafe.tv': [programme('cafe.tv', 'Café à Londres', NOW.getTime() - HOUR, NOW.getTime() + HOUR)]
      })],
      epgSourceLabels: ['provider'],
      hiddenSourceUrls: [],
      manualMappings: [],
      primaryPlaylistId: null,
      now: NOW
    })
    expect(searchGuideProgrammes(index, 'londres', NOW)).toHaveLength(1)
  })

  it('caps the result set', () => {
    const programmes = Array.from({ length: 50 }, (_, i) =>
      programme('one.hd', `Cap Show ${i}`, NOW.getTime() + (i + 1) * HOUR, NOW.getTime() + (i + 2) * HOUR)
    )
    const index = buildGuideSearchIndex({
      liveStreams: [stream(1, 'One HD', 'one.hd')],
      epgSources: [guide([['one.hd', 'One HD']], { 'one.hd': programmes })],
      epgSourceLabels: ['provider'],
      hiddenSourceUrls: [],
      manualMappings: [],
      primaryPlaylistId: null,
      now: NOW
    })
    expect(searchGuideProgrammes(index, 'cap show', NOW, 5)).toHaveLength(5)
  })
})
