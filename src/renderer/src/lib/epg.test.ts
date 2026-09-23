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
  unionEpgSourceUrls,
  buildGuideIndex,
  resolveStreamToGuide,
  suggestGuideChannels,
  planBulkSuggestionApply,
  parseXmltvProgressive
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

describe('guide index, stream resolution, and suggestions', () => {
  const guide = parseXmltv(`<tv>
    <channel id="bbcone.uk"><display-name>BBC One</display-name></channel>
    <channel id="bbctwo.uk"><display-name>BBC Two</display-name></channel>
    <channel id="sky.uk"><display-name>Sky Sports</display-name></channel>
    <programme start="20300101120000 +0000" stop="20300101130000 +0000" channel="bbcone.uk"><title>One</title></programme>
    <programme start="20300101120000 +0000" stop="20300101130000 +0000" channel="bbctwo.uk"><title>Two</title></programme>
    <programme start="20300101120000 +0000" stop="20300101130000 +0000" channel="sky.uk"><title>Three</title></programme>
  </tv>`)

  it('reports the matched channel, join method, and programme count per stream', () => {
    const index = buildGuideIndex(guide)
    expect(resolveStreamToGuide(makeStream({ stream_id: 1, name: '101 BBC One HD' }), index)).toMatchObject({
      channelId: 'bbcone.uk',
      method: 'fuzzy',
      programmeCount: 1
    })
    // A matched guide channel with no programmes resolves with programmeCount 0 — a match, but
    // not usable guide data; this is the rule the "only unmatched" filter and the report share.
    const emptyGuide = parseXmltv(`<tv><channel id="empty.uk"><display-name>Empty Channel</display-name></channel></tv>`)
    expect(resolveStreamToGuide(makeStream({ stream_id: 2, name: 'Empty Channel' }), buildGuideIndex(emptyGuide))).toMatchObject({
      channelId: 'empty.uk',
      method: 'name',
      programmeCount: 0
    })
    expect(resolveStreamToGuide(makeStream({ stream_id: 3, name: 'Totally Unrelated' }), index)).toBeNull()
  })

  it('honours a manual mapping for the stream, falling through when it is stale', () => {
    const index = buildGuideIndex(guide)
    expect(resolveStreamToGuide(makeStream({ stream_id: 4, name: 'Anything' }), index, 'bbctwo.uk')).toMatchObject({
      channelId: 'bbctwo.uk',
      method: 'manual'
    })
    expect(resolveStreamToGuide(makeStream({ stream_id: 5, name: 'BBC One' }), index, 'gone.channel')).toMatchObject({
      channelId: 'bbcone.uk',
      method: 'name'
    })
  })

  it('ranks suggestions by token similarity and refuses coin-flip candidates', () => {
    const index = buildGuideIndex(guide)
    const suggestions = suggestGuideChannels('UK: BBC One FHD (VIP)', index)
    expect(suggestions[0]).toMatchObject({ channelId: 'bbcone.uk', score: 1 })
    // "BBC Two" shares only the generic "bbc" token (score 0.5) — deliberately not offered.
    expect(suggestions.map((s) => s.channelId)).toEqual(['bbcone.uk'])
  })

  it('respects the suggestion limit and returns nothing for an empty name', () => {
    const index = buildGuideIndex(guide)
    expect(suggestGuideChannels('Sky Sports', index, 1)).toHaveLength(1)
    expect(suggestGuideChannels('   ', index)).toEqual([])
  })
})

describe('planBulkSuggestionApply', () => {
  // bbcone carries a programme; bbctwo is a guide entry with none — so a channel that matches
  // bbctwo is "matched but not resolved", exactly the case the bulk planner exists for.
  const guide = parseXmltv(`<tv>
    <channel id="bbcone"><display-name>BBC One</display-name></channel>
    <channel id="bbctwo"><display-name>BBC Two</display-name></channel>
    <programme start="20300101120000 +0000" stop="20300101130000 +0000" channel="bbcone"><title>Show</title></programme>
  </tv>`)

  it('plans mappings only for unresolved channels whose best candidate clears the threshold', () => {
    const index = buildGuideIndex(guide)
    const plan = planBulkSuggestionApply(
      [
        makeStream({ stream_id: 1, name: 'BBC One' }), // exact name match, has programmes → skipped
        makeStream({ stream_id: 2, name: '101 BBC One HD' }), // relaxed match, has programmes → skipped
        makeStream({ stream_id: 3, name: 'BBC Two HD' }), // matches bbctwo, which has no programmes → planned
        makeStream({ stream_id: 4, name: 'Totally Unrelated' }) // no candidate at all
      ],
      index,
      new Map(),
      0.8
    )
    expect(plan.applied).toEqual([{ streamId: 3, channelId: 'bbctwo', score: 1 }])
    expect(plan.considered).toBe(2)
    expect(plan.belowThreshold).toBe(1)
    expect(plan.alreadyMapped).toBe(0)
  })

  it('never overwrites — or even re-plans — a channel that already has a manual mapping', () => {
    const index = buildGuideIndex(guide)
    const plan = planBulkSuggestionApply(
      [makeStream({ stream_id: 3, name: 'BBC Two HD' })],
      index,
      new Map([[3, 'bbctwo']]),
      0.8
    )
    expect(plan.applied).toEqual([])
    expect(plan.alreadyMapped).toBe(1)
    expect(plan.considered).toBe(0)
  })

  it('respects the threshold exactly at the boundary', () => {
    const index = buildGuideIndex(guide)
    // "BBC One Extra" scores 2*2/(3+2) = 0.8 against BBC One (and matches nothing else), so it
    // qualifies at 0.8 and not at 0.9.
    const streams = [makeStream({ stream_id: 5, name: 'BBC One Extra' })]
    expect(planBulkSuggestionApply(streams, index, new Map(), 0.8).applied).toHaveLength(1)
    expect(planBulkSuggestionApply(streams, index, new Map(), 0.9).applied).toHaveLength(0)
    expect(planBulkSuggestionApply(streams, index, new Map(), 0.9).belowThreshold).toBe(1)
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

  it('joins through the relaxed tier when presentation noise differs, reporting the method', () => {
    const guide2 = parseXmltv(`<tv>
      <channel id="bbcone.uk"><display-name>BBC One</display-name></channel>
      <channel id="cafe.fr"><display-name>Café</display-name></channel>
      <channel id="crimeinv.us"><display-name>Crime + Investigation</display-name></channel>
      <channel id="skysports.uk"><display-name>Sky Sports</display-name></channel>
    </tv>`)
    // Quality tag + leading channel-list position ("101 BBC One HD")
    expect(matchXmltvChannels([makeStream({ stream_id: 20, name: '101 BBC One HD' })], guide2).get(20)).toEqual({
      channelId: 'bbcone.uk',
      method: 'fuzzy'
    })
    // Diacritics fold
    expect(matchXmltvChannels([makeStream({ stream_id: 21, name: 'CAFE' })], guide2).get(21)).toEqual({
      channelId: 'cafe.fr',
      method: 'fuzzy'
    })
    // "&" vs "+": both vanish in the exact normalizer, so this is already an exact name join
    expect(matchXmltvChannels([makeStream({ stream_id: 22, name: 'Crime & Investigation' })], guide2).get(22)).toEqual({
      channelId: 'crimeinv.us',
      method: 'name'
    })
    // "and" spelled out only joins via the relaxed tier (the exact normalizer keeps it)
    expect(matchXmltvChannels([makeStream({ stream_id: 23, name: 'Crime and Investigation' })], guide2).get(23)).toEqual({
      channelId: 'crimeinv.us',
      method: 'fuzzy'
    })
    // Country prefix + quality tag + parenthetical noise ("UK: Sky Sports FHD (VIP)")
    expect(matchXmltvChannels([makeStream({ stream_id: 24, name: 'UK: Sky Sports FHD (VIP)' })], guide2).get(24)).toEqual({
      channelId: 'skysports.uk',
      method: 'fuzzy'
    })
  })

  it('relaxed matching does not over-reach across genuinely different channels', () => {
    const guide2 = parseXmltv(`<tv>
      <channel id="one"><display-name>BBC One</display-name></channel>
      <channel id="two"><display-name>BBC Two</display-name></channel>
    </tv>`)
    expect(matchXmltvChannels([makeStream({ stream_id: 30, name: 'BBC Two HD' })], guide2).get(30)).toEqual({
      channelId: 'two',
      method: 'fuzzy'
    })
    // A channel the guide has no counterpart for stays unmatched — fuzzy is not "close enough".
    expect(matchXmltvChannels([makeStream({ stream_id: 31, name: 'BBC Three' })], guide2).has(31)).toBe(false)
  })

  it('exact joins still win over the relaxed tier', () => {
    const guide2 = parseXmltv(`<tv>
      <channel id="one"><display-name>BBC One</display-name></channel>
      <channel id="onehd"><display-name>BBC One HD</display-name></channel>
    </tv>`)
    expect(matchXmltvChannels([makeStream({ stream_id: 40, name: 'BBC One HD' })], guide2).get(40)).toEqual({
      channelId: 'onehd',
      method: 'name'
    })
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

describe('parseXmltvProgressive', () => {
  // The whole point of the sectioned parse is that nothing observable changes — so the tests that
  // matter are equivalences against the single-shot parse it replaces.
  const guide = (channels: number, programmesPerChannel: number): string => {
    const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="t">']
    for (let c = 0; c < channels; c += 1) {
      parts.push(`<channel id="c${c}"><display-name>Channel ${c} HD</display-name></channel>`)
      for (let p = 0; p < programmesPerChannel; p += 1) {
        // Interleaved start times, so a section cut can land between a channel's programmes.
        const hour = String(6 + ((c + p) % 18)).padStart(2, '0')
        parts.push(
          `<programme start="20260923${hour}0000 +0000" stop="20260923${hour}3000 +0000" channel="c${c}">` +
            `<title>Show ${c}-${p}</title><desc>About ${c}-${p}</desc></programme>`
        )
      }
    }
    parts.push('</tv>')
    return parts.join('\n')
  }

  const summarise = (data: { channels: Map<string, unknown>; programmesByChannel: Map<string, { start: Date; title: string }[]> }) => ({
    channels: [...data.channels.keys()].sort(),
    programmes: [...data.programmesByChannel.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, list]) => [id, list.map((p) => `${p.start.toISOString()}|${p.title}`)])
  })

  it('produces exactly the same guide as parsing the whole document in one call', async () => {
    const xml = guide(12, 6)
    const single = parseXmltv(xml)
    // A deliberately tiny budget so the document is cut many times, including mid-channel.
    const sectioned = await parseXmltvProgressive(xml, { maxSectionChars: 300, yieldTo: () => Promise.resolve() })

    expect(summarise(sectioned)).toEqual(summarise(single))
  })

  it('reports progress once per section, ending at the total', async () => {
    const seen: Array<[number, number]> = []
    await parseXmltvProgressive(guide(10, 5), {
      maxSectionChars: 400,
      yieldTo: () => Promise.resolve(),
      onProgress: (done, total) => seen.push([done, total])
    })

    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1][0]).toBe(seen[seen.length - 1][1])
    // Monotonic, one step per section.
    expect(seen.map(([done]) => done)).toEqual(seen.map((_, i) => i + 1))
  })

  it('yields between sections but not after the last one — the caller is not kept waiting', async () => {
    let yields = 0
    await parseXmltvProgressive(guide(10, 5), {
      maxSectionChars: 400,
      yieldTo: () => {
        yields += 1
        return Promise.resolve()
      }
    })
    // One fewer yield than sections: there is nothing left to let run once the work is done.
    expect(yields).toBeGreaterThan(0)
  })

  it('falls back to the plain parse when there is nothing to cut', async () => {
    const xml = guide(2, 2)
    const sectioned = await parseXmltvProgressive(xml)
    expect(summarise(sectioned)).toEqual(summarise(parseXmltv(xml)))
  })
})
