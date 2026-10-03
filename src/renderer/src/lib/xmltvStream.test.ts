import { describe, it, expect } from 'vitest'
import { XMLParser } from 'fast-xml-parser'
import { createXmltvStreamParser } from './xmltvStream'
import type { EpgChannel, EpgData, EpgProgramme } from './epg'

// The streaming scanner's contract (ported from the web sibling's proof of the same name):
// for every well-formed input, the same guide the fast-xml-parser DOM parse produced — the DOM
// implementation parseXmltv used until the port, kept here as the parity reference — regardless
// of how the document is split into chunks. The scanner replaced the DOM because a document
// tree costs ~6.5x the XML in heap (measured on the web sibling: 1.3GB for a 195MB guide).

/** The old DOM parse, verbatim from epg.ts before the scanner replaced it — the reference. */
function domParseXmltv(xml: string): EpgData {
  function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  }
  function textOf(value: unknown): string | undefined {
    if (value == null) return undefined
    if (typeof value === 'string') return value
    if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
      return String((value as Record<string, unknown>)['#text'])
    }
    return String(value)
  }
  function parseXmltvDate(value: string): Date {
    const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/)
    if (!match) return new Date(value)
    const [, year, month, day, hour, minute, second, offset] = match
    const normalizedOffset = offset ? `${offset.slice(0, 3)}:${offset.slice(3)}` : 'Z'
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${normalizedOffset}`)
  }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const rootStart = xml.search(/<\?xml|<tv[\s>]/i)
  const doc = parser.parse(rootStart > 0 ? xml.slice(rootStart) : xml) as {
    tv?: { channel?: unknown; programme?: unknown }
  }
  const tv = doc.tv ?? {}
  const channels = new Map<string, EpgChannel>()
  for (const raw of asArray(tv.channel as any)) {
    const id = String(raw['@_id'])
    const displayName = textOf(raw['display-name']) ?? id
    const icon = raw.icon?.['@_src']
    channels.set(id, icon !== undefined ? { id, displayName, icon } : { id, displayName })
  }
  const programmesByChannel = new Map<string, EpgProgramme[]>()
  for (const raw of asArray(tv.programme as any)) {
    const channelId = String(raw['@_channel'])
    const programme = {
      channelId,
      start: parseXmltvDate(String(raw['@_start'])),
      stop: parseXmltvDate(String(raw['@_stop'])),
      title: textOf(raw.title) ?? 'Untitled',
      description: textOf(raw.desc)
    }
    const list = programmesByChannel.get(channelId)
    if (list) list.push(programme)
    else programmesByChannel.set(channelId, [programme])
  }
  for (const list of programmesByChannel.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime())
  }
  return { channels, programmesByChannel }
}

function scan(xml: string): EpgData {
  const parser = createXmltvStreamParser()
  parser.write(xml)
  return parser.end()
}

/** Structural equality on the guide: maps and Date fields compared by value. */
function expectSameGuide(actual: EpgData, expected: EpgData): void {
  expect([...actual.channels.entries()]).toEqual([...expected.channels.entries()])
  expect([...actual.programmesByChannel.keys()]).toEqual([...expected.programmesByChannel.keys()])
  for (const [channel, list] of expected.programmesByChannel) {
    const mine = actual.programmesByChannel.get(channel) ?? []
    expect(mine.map((p) => ({ ...p, start: p.start.getTime(), stop: p.stop.getTime() }))).toEqual(
      list.map((p) => ({ ...p, start: p.start.getTime(), stop: p.stop.getTime() }))
    )
  }
}

const FIXTURES: Record<string, string> = {
  'channels with names, icons; programmes with titles and descriptions': `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="chan.one"><display-name>Channel One</display-name><icon src="http://example.com/icon.png" /></channel>
  <channel id="chan.two"><display-name>Channel Two</display-name></channel>
  <programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="chan.one"><title>Noon Show</title><desc>A show at noon.</desc></programme>
  <programme start="20260101130000 +0000" stop="20260101140000 +0000" channel="chan.one"><title>Afternoon Show</title></programme>
</tv>`,
  'entities in text and attributes': `<tv><channel id="chan&amp;one"><display-name>A &lt;b&gt;old&lt;/b&gt; name &amp; more</display-name></channel>
<programme start="20260101120000 +0100" stop="20260101130000 +0100" channel="chan&amp;one"><title>&quot;Quoted&quot; &amp; &#39;titled&#39;</title><desc>Numeric: &#65;&#66;&#67; and hex: &#x41;</desc></programme></tv>`,
  'cdata leaves': `<tv><channel id="c"><display-name><![CDATA[Plain & simple]]></display-name></channel>
<programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="c"><title><![CDATA[Raw & undecoded <b>markup</b>]]></title></programme></tv>`,
  'leaf attributes (lang tags) are not text': `<tv><channel id="c"><display-name>C</display-name></channel>
<programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="c"><title lang="en">English title</title><desc lang="en">English desc</desc></programme></tv>`,
  'unsorted programmes, per-channel sort': `<tv>
<programme start="20260101140000 +0000" stop="20260101150000 +0000" channel="c1"><title>Later</title></programme>
<programme start="20260101110000 +0000" stop="20260101120000 +0000" channel="c1"><title>Earlier</title></programme>
<programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="c2"><title>Other channel</title></programme>
</tv>`,
  'missing title falls back to Untitled; missing desc stays undefined': `<tv><channel id="c"><display-name>C</display-name></channel>
<programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="c"><desc>Only a desc</desc></programme></tv>`,
  'unparseable dates are kept as Invalid Dates (consumers filter them)': `<tv><channel id="c"><display-name>C</display-name></channel>
<programme start="not-a-date" stop="20260101130000 +0000" channel="c"><title>Broken</title></programme></tv>`,
  'no timezone offset means UTC': `<tv><channel id="c"><display-name>C</display-name></channel>
<programme start="20260101120000" stop="20260101130000" channel="c"><title>T</title></programme></tv>`,
  'empty tv root is an empty guide, not an error': `<tv></tv>`,
  'self-closing channel': `<tv><channel id="bare"/></tv>`,
  'bom and preamble junk before the root': `\uFEFFjunk before<?xml version="1.0"?><tv><channel id="c"><display-name>C</display-name></channel></tv>`,
  'comments between elements': `<tv><!-- a comment with <programme channel="fake"> inside --><channel id="c"><display-name>C</display-name></channel><!-- another --></tv>`,
  'tag-free plain text is an empty guide (the .txt-schedule advice path)': 'Weekly Schedule\nMonday: News at 6\n'
}

describe('createXmltvStreamParser: parity with the DOM parse', () => {
  for (const [name, xml] of Object.entries(FIXTURES)) {
    it(`matches the DOM parse: ${name}`, () => {
      expectSameGuide(scan(xml), domParseXmltv(xml))
    })
  }
})

describe('createXmltvStreamParser: chunk boundaries', () => {
  const xml = `<?xml version="1.0"?><!-- lead comment -->
<tv><channel id="a&amp;b"><display-name><![CDATA[CD & <ATA> TV]]></display-name><icon src='http://l/a.png'/></channel>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="a&amp;b"><title>First &amp; only</title><desc>One &amp; all &lt;here&gt;</desc></programme>
<programme start="20261003133000 +0000" stop="20261003143000 +0000" channel="a&amp;b"><title>Second</title></programme></tv>`

  it('produces the same guide when the document is split at EVERY byte offset', () => {
    const whole = scan(xml)
    for (let split = 1; split < xml.length - 1; split++) {
      const parser = createXmltvStreamParser()
      parser.write(xml.slice(0, split))
      parser.write(xml.slice(split))
      try {
        expectSameGuide(parser.end(), whole)
      } catch (err) {
        throw new Error(`chunk split at offset ${split} changed the output: ${String(err)}`)
      }
    }
  })

  it('tolerates per-character writes', () => {
    const parser = createXmltvStreamParser()
    for (const ch of xml) parser.write(ch)
    const guide = parser.end()
    expect(guide.channels.size).toBe(1)
    expect(guide.programmesByChannel.get('a&b')?.length).toBe(2)
  })
})

describe('createXmltvStreamParser: documented deviations from the DOM parse', () => {
  it('keeps the FIRST title/desc/display-name/icon of a repeated element', () => {
    const xml = `<tv><channel id="c"><icon src="one.png"/><icon src="two.png"/><display-name>One</display-name><display-name>Two</display-name></channel>
<programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="c"><title lang="en">English</title><title lang="de">Deutsch</title></programme></tv>`
    const guide = scan(xml)
    // The DOM path's array-shaped multi-title reached textOf as an object without #text and
    // surfaced as "[object Object]" (and multi-icon as no icon at all) — the first-value
    // behavior is what every EPG surface actually wants, so the scanner pins it.
    expect(guide.programmesByChannel.get('c')?.[0]?.title).toBe('English')
    expect(guide.channels.get('c')?.displayName).toBe('One')
    expect(guide.channels.get('c')?.icon).toBe('one.png')
  })

  it('throws for corrupt junk with no guide structure at all (the corrupt-cache refetch contract)', () => {
    const junk = 'not a guide <<<'
    // That throw is what the once-a-day cache's corrupt-copy fallback keys off (useAppStore's
    // catch → refetch) — the old DOM parse threw for this input too (fast-xml-parser's own
    // parse error; the DOM reference above is not asserted here because the DOM's exact throw
    // boundary is parser-quirk, not contract — the end-to-end corrupt-cache test in
    // useAppStore.test.ts pins the behavior that matters).
    expect(() => scan(junk)).toThrow(/Not an XMLTV guide/)
    // Tag-free text is NOT junk: it parses to an empty guide, which the custom-source path
    // reports with its plain-text-schedule advice.
    expect(() => scan('')).not.toThrow()
    expect(() => scan('\n  \t')).not.toThrow()
  })

  it('throws on a document truncated mid-element', () => {
    const parser = createXmltvStreamParser()
    parser.write('<tv><channel id="a"><display-name>A</display-name>')
    expect(() => parser.end()).toThrow(/truncated/)
  })

  it('resynchronizes after a pathological unterminated element', () => {
    const garbage = 'x'.repeat(6 * 1024 * 1024)
    const parser = createXmltvStreamParser()
    parser.write(`<tv><channel id="junk"><display-name>${garbage}`)
    parser.write('</channel>')
    parser.write('<channel id="good"><display-name>Good</display-name></channel>')
    const guide = parser.end()
    expect(guide.channels.get('good')?.displayName).toBe('Good')
  })
})
