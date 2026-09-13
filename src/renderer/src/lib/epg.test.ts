import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import {
  parseXmltv,
  getCurrentProgramme,
  getNextProgramme,
  xmltvProgrammesToShort,
  mergeShortEpg,
  matchXmltvChannels,
  decodeMaybeGzipBytes,
  unionEpgSourceUrls
} from './epg'
import type { LiveStream, ShortEpgProgram } from './types'

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="chan.one"><display-name>Channel One</display-name><icon src="http://example.com/icon.png" /></channel>
  <channel id="chan.two"><display-name>Channel Two</display-name></channel>
  <programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="chan.one">
    <title>Noon Show</title>
    <desc>A show at noon.</desc>
  </programme>
  <programme start="20260101130000 +0000" stop="20260101140000 +0000" channel="chan.one">
    <title>Afternoon Show</title>
  </programme>
</tv>`

describe('parseXmltv', () => {
  it('parses channels with display names and icons', () => {
    const { channels } = parseXmltv(SAMPLE_XML)
    expect(channels.get('chan.one')).toEqual({
      id: 'chan.one',
      displayName: 'Channel One',
      icon: 'http://example.com/icon.png'
    })
    expect(channels.get('chan.two')?.displayName).toBe('Channel Two')
  })

  it('parses programmes with correct UTC-derived timestamps', () => {
    const { programmesByChannel } = parseXmltv(SAMPLE_XML)
    const programmes = programmesByChannel.get('chan.one')
    expect(programmes).toHaveLength(2)
    expect(programmes?.[0].title).toBe('Noon Show')
    expect(programmes?.[0].description).toBe('A show at noon.')
    expect(programmes?.[0].start.toISOString()).toBe('2026-01-01T12:00:00.000Z')
    expect(programmes?.[0].stop.toISOString()).toBe('2026-01-01T13:00:00.000Z')
  })

  it('sorts programmes by start time within a channel', () => {
    const outOfOrderXml = `<tv>
      <programme start="20260101130000 +0000" stop="20260101140000 +0000" channel="c"><title>Second</title></programme>
      <programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="c"><title>First</title></programme>
    </tv>`
    const { programmesByChannel } = parseXmltv(outOfOrderXml)
    const programmes = programmesByChannel.get('c')
    expect(programmes?.map((p) => p.title)).toEqual(['First', 'Second'])
  })

  it('handles a guide with no channels or programmes without throwing', () => {
    const { channels, programmesByChannel } = parseXmltv('<tv></tv>')
    expect(channels.size).toBe(0)
    expect(programmesByChannel.size).toBe(0)
  })

  it('skips a leading BOM/preamble before the XML root (.txt files that are really XMLTV)', () => {
    const { channels } = parseXmltv(`\uFEFFWeekly schedule — provider X (do not edit)\n${SAMPLE_XML}`)
    expect(channels.get('chan.one')?.displayName).toBe('Channel One')
    expect(channels.get('chan.two')?.displayName).toBe('Channel Two')
  })
})

describe('getCurrentProgramme / getNextProgramme', () => {
  const { programmesByChannel } = parseXmltv(SAMPLE_XML)
  const programmes = programmesByChannel.get('chan.one')

  it('finds the programme spanning the given time', () => {
    const at = new Date('2026-01-01T12:30:00.000Z')
    expect(getCurrentProgramme(programmes, at)?.title).toBe('Noon Show')
  })

  it('returns undefined when no programme spans the given time', () => {
    const before = new Date('2026-01-01T00:00:00.000Z')
    expect(getCurrentProgramme(programmes, before)).toBeUndefined()
  })

  it('finds the next programme after the given time', () => {
    const at = new Date('2026-01-01T12:30:00.000Z')
    expect(getNextProgramme(programmes, at)?.title).toBe('Afternoon Show')
  })

  it('returns undefined for next programme past the end of the guide', () => {
    const at = new Date('2026-01-01T23:00:00.000Z')
    expect(getNextProgramme(programmes, at)).toBeUndefined()
  })
})

// --- multi-source guide pool helpers (0.7.59) ---

function makeStream(overrides: Partial<LiveStream>): LiveStream {
  return {
    num: 1,
    name: 'Channel',
    stream_type: 'live',
    stream_id: 1,
    stream_icon: '',
    epg_channel_id: null,
    added: '',
    category_id: '1',
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0,
    ...overrides
  }
}

function shortProgram(title: string, startSec: number, stopSec: number, id = title): ShortEpgProgram {
  return {
    id,
    epg_id: '',
    title,
    lang: '',
    start: new Date(startSec * 1000).toISOString(),
    end: new Date(stopSec * 1000).toISOString(),
    description: '',
    channel_id: '',
    start_timestamp: String(startSec),
    stop_timestamp: String(stopSec)
  }
}

describe('xmltvProgrammesToShort', () => {
  const now = new Date('2026-06-01T12:00:00.000Z')

  it('maps programmes to ShortEpgProgram shape with epoch timestamps', () => {
    const out = xmltvProgrammesToShort(
      [
        {
          channelId: 'c',
          start: new Date('2026-06-01T12:00:00.000Z'),
          stop: new Date('2026-06-01T13:00:00.000Z'),
          title: 'Show',
          description: 'Desc'
        }
      ],
      'c',
      now
    )
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Show')
    expect(out[0].description).toBe('Desc')
    expect(out[0].start_timestamp).toBe(String(Date.parse('2026-06-01T12:00:00.000Z') / 1000))
    expect(out[0].stop_timestamp).toBe(String(Date.parse('2026-06-01T13:00:00.000Z') / 1000))
  })

  it('drops already-ended programmes and unparseable timestamps', () => {
    const out = xmltvProgrammesToShort(
      [
        {
          channelId: 'c',
          start: new Date('2026-06-01T10:00:00.000Z'),
          stop: new Date('2026-06-01T11:00:00.000Z'),
          title: 'Ended'
        },
        { channelId: 'c', start: new Date(NaN), stop: new Date(NaN), title: 'Broken' },
        {
          channelId: 'c',
          start: new Date('2026-06-01T14:00:00.000Z'),
          stop: new Date('2026-06-01T15:00:00.000Z'),
          title: 'Future'
        }
      ],
      'c',
      now
    )
    expect(out.map((p) => p.title)).toEqual(['Future'])
  })
})

describe('mergeShortEpg', () => {
  it('keeps primary entries and appends non-overlapping secondary entries sorted by start', () => {
    const primary = [shortProgram('Provider Now', 100, 200)]
    const secondary = [shortProgram('Pool Later', 300, 400), shortProgram('Pool Much Later', 500, 600)]
    const merged = mergeShortEpg(primary, secondary)
    expect(merged.map((p) => p.title)).toEqual(['Provider Now', 'Pool Later', 'Pool Much Later'])
  })

  it('drops secondary entries that overlap a primary entry (provider wins its slots)', () => {
    const primary = [shortProgram('Provider Now', 100, 200)]
    const secondary = [
      shortProgram('Pool Same Slot', 150, 250), // overlaps
      shortProgram('Pool Adjacent', 200, 300), // touches at the boundary, no overlap
      shortProgram('Pool Gap', 40, 90) // earlier gap-filler, no overlap
    ]
    const merged = mergeShortEpg(primary, secondary)
    expect(merged.map((p) => p.title)).toEqual(['Pool Gap', 'Provider Now', 'Pool Adjacent'])
  })

  it('drops secondary entries with unparseable timestamps rather than misplacing them', () => {
    const merged = mergeShortEpg([shortProgram('P', 100, 200)], [
      { ...shortProgram('Bad', 0, 0), start_timestamp: 'not-a-number', stop_timestamp: 'nope' }
    ])
    expect(merged.map((p) => p.title)).toEqual(['P'])
  })
})

describe('decodeMaybeGzipBytes', () => {
  it('decompresses a gzip-compressed guide (the .xml.gz form many providers serve)', async () => {
    const gzipped = gzipSync(Buffer.from(SAMPLE_XML, 'utf8'))
    const xml = await decodeMaybeGzipBytes(gzipped.buffer.slice(gzipped.byteOffset, gzipped.byteOffset + gzipped.byteLength))
    expect(xml).toBe(SAMPLE_XML)
    // And the decompressed output parses as a normal guide.
    expect(parseXmltv(xml).channels.get('chan.one')?.displayName).toBe('Channel One')
  })

  it('passes plain XML through untouched', async () => {
    const xml = await decodeMaybeGzipBytes(new TextEncoder().encode(SAMPLE_XML).buffer)
    expect(xml).toBe(SAMPLE_XML)
  })

  it('handles degenerate short bodies without throwing', async () => {
    expect(await decodeMaybeGzipBytes(new ArrayBuffer(0))).toBe('')
    expect(await decodeMaybeGzipBytes(new Uint8Array([0x3c]).buffer)).toBe('<')
  })
})

describe('parseXmltv entity-expansion guard', () => {
  it('parses a guide with more than 1000 entity references (real-world XMLTV guides are entity-dense)', () => {
    // 1500 &amp; references in one display-name alone — the stock fast-xml-parser cap of
    // 1000 total expansions rejects this exact document ("Entity expansion limit exceeded:
    // 1001 > 1000"), which is what made healthy guides load as "Couldn't load" in Settings.
    const xml = `<?xml version="1.0"?>
<tv>
  <channel id="c1"><display-name>X${'&amp;'.repeat(1500)}</display-name></channel>
  <programme start="20300101120000 +0000" stop="20300101130000 +0000" channel="c1">
    <title>Show &quot;round the Clock &amp; More</title>
  </programme>
</tv>`
    const parsed = parseXmltv(xml)
    expect(parsed.channels.get('c1')?.displayName).toBe('X' + '&'.repeat(1500))
    // Named entities still decode correctly — the cap was raised, not entity processing disabled.
    expect(parsed.programmesByChannel.get('c1')?.[0]?.title).toBe('Show "round the Clock & More')
  })
})

describe('unionEpgSourceUrls', () => {
  const provider = 'Provider guide (xmltv.php)'

  it('lists persisted urls in saved order, then any live-but-unpersisted source, excluding the provider guide', () => {
    expect(
      unionEpgSourceUrls(['http://b.xml', 'http://a.xml'], [provider, 'http://a.xml', 'http://stale.xml'], provider)
    ).toEqual(['http://b.xml', 'http://a.xml', 'http://stale.xml'])
  })

  it('returns just the persisted list when live labels match it exactly', () => {
    expect(unionEpgSourceUrls(['http://a.xml'], ['http://a.xml'], provider)).toEqual(['http://a.xml'])
  })

  it('returns nothing for a fresh setup with no sources at all', () => {
    expect(unionEpgSourceUrls([], [], provider)).toEqual([])
  })
})

describe('matchXmltvChannels', () => {
  const guide = parseXmltv(`<tv>
    <channel id="provider.1"><display-name>Provider One Label</display-name></channel>
    <channel id="NameMatch.uk"><display-name>BBC One</display-name></channel>
  </tv>`)

  it('matches by exact epg_channel_id first, reporting the method', () => {
    const matches = matchXmltvChannels([makeStream({ stream_id: 7, name: 'Whatever', epg_channel_id: 'provider.1' })], guide)
    expect(matches.get(7)).toEqual({ channelId: 'provider.1', method: 'id' })
  })

  it('falls back to a normalized display-name match when the id is absent, reporting the method', () => {
    const matches = matchXmltvChannels([makeStream({ stream_id: 8, name: 'BBC  One!' })], guide)
    expect(matches.get(8)).toEqual({ channelId: 'NameMatch.uk', method: 'name' })
  })

  it('leaves unmatched streams out of the result entirely', () => {
    const matches = matchXmltvChannels([makeStream({ stream_id: 9, name: 'Nothing Like This' })], guide)
    expect(matches.has(9)).toBe(false)
  })

  it('prefers a manual mapping over both automatic joins, reporting the method', () => {
    const manual = new Map([[7, 'NameMatch.uk']])
    const matches = matchXmltvChannels([makeStream({ stream_id: 7, name: 'Whatever', epg_channel_id: 'provider.1' })], guide, manual)
    expect(matches.get(7)).toEqual({ channelId: 'NameMatch.uk', method: 'manual' })
  })

  it('falls back to automatic matching when a manual mapping points at a channel the guide no longer has', () => {
    const manual = new Map([[8, 'renumbered.away']])
    const matches = matchXmltvChannels([makeStream({ stream_id: 8, name: 'BBC  One!' })], guide, manual)
    expect(matches.get(8)).toEqual({ channelId: 'NameMatch.uk', method: 'name' })
  })

  it('lets several streams share one manually-mapped guide channel (HD/SD twins off one feed)', () => {
    const manual = new Map([
      [10, 'NameMatch.uk'],
      [11, 'NameMatch.uk']
    ])
    const matches = matchXmltvChannels(
      [makeStream({ stream_id: 10, name: 'BBC One HD' }), makeStream({ stream_id: 11, name: 'BBC One SD' })],
      guide,
      manual
    )
    expect(matches.get(10)).toEqual({ channelId: 'NameMatch.uk', method: 'manual' })
    expect(matches.get(11)).toEqual({ channelId: 'NameMatch.uk', method: 'manual' })
  })
})
