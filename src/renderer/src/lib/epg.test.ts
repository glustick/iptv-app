import { describe, it, expect } from 'vitest'
import { parseXmltv, getCurrentProgramme, getNextProgramme } from './epg'

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
