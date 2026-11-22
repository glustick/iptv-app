import { describe, expect, it } from 'vitest'
import { buildCatchupTimeline, windowExtentLabel, WINDOW_EXTENT_MIN_MS } from './catchupTimeline'
import type { ShortEpgProgram } from './types'

/** A ShortEpgProgram shaped like the client decodes: timestamps arrive as epoch SECONDS
 *  strings (the Xtream API's unit) — the lib converts once on entry. */
function programme(startSeconds: number, stopSeconds: number, title = 'A Show'): ShortEpgProgram {
  return {
    id: '1',
    epg_id: 'one.hd',
    title,
    lang: '',
    start: new Date(startSeconds * 1000).toISOString(),
    end: new Date(stopSeconds * 1000).toISOString(),
    description: '',
    channel_id: 'one.hd',
    start_timestamp: String(startSeconds),
    stop_timestamp: String(stopSeconds)
  }
}

const NOW = 1_800_000_000_000 // a fixed "now" (epoch ms) — every test anchors to it
const MIN = 60_000
const HOUR = 3_600_000

describe('buildCatchupTimeline', () => {
  it('places a programme fully inside the window at proportional fractions (seconds→ms conversion)', () => {
    // Window: [now - 4h, now]. Programme runs [now - 3h, now - 1h] → 25%..75%.
    const markers = buildCatchupTimeline(
      { startMs: NOW - 4 * HOUR, endMs: NOW },
      [programme((NOW - 3 * HOUR) / 1000, (NOW - 1 * HOUR) / 1000)],
      NOW
    )
    expect(markers).toHaveLength(1)
    expect(markers[0].title).toBe('A Show')
    expect(markers[0].startFraction).toBeCloseTo(0.25, 10)
    expect(markers[0].endFraction).toBeCloseTo(0.75, 10)
    expect(markers[0].isCurrent).toBe(false)
  })

  it('clips a programme that starts before the window and one that ends after it', () => {
    const markers = buildCatchupTimeline(
      { startMs: NOW - 4 * HOUR, endMs: NOW },
      [
        // starts 6h back, ends 2h back → visible only from the window's own start (0) to 0.5
        programme((NOW - 6 * HOUR) / 1000, (NOW - 2 * HOUR) / 1000, 'Started too early'),
        // starts 2h back, ends 1h past now → visible 0.5..1, clipped at the live edge
        programme((NOW - 2 * HOUR) / 1000, (NOW + HOUR) / 1000, 'Runs past live')
      ],
      NOW
    )
    expect(markers.map((m) => m.title)).toEqual(['Started too early', 'Runs past live'])
    expect(markers[0].startFraction).toBeCloseTo(0, 10)
    expect(markers[0].endFraction).toBeCloseTo(0.5, 10)
    expect(markers[1].startFraction).toBeCloseTo(0.5, 10)
    expect(markers[1].endFraction).toBeCloseTo(1, 10)
  })

  it('drops programmes with no overlap and keeps the current one highlighted across the boundary', () => {
    const markers = buildCatchupTimeline(
      { startMs: NOW - 2 * HOUR, endMs: NOW },
      [
        // entirely before the window → dropped, not squashed onto the left edge
        programme((NOW - 5 * HOUR) / 1000, (NOW - 3 * HOUR) / 1000, 'Long over'),
        // spans the boundary: started before now, still on → highlighted
        programme((NOW - 30 * MIN) / 1000, (NOW + 30 * MIN) / 1000, 'On now'),
        // entirely after the window → dropped too
        programme((NOW + HOUR) / 1000, (NOW + 2 * HOUR) / 1000, 'Upcoming')
      ],
      NOW
    )
    expect(markers).toHaveLength(1)
    expect(markers[0].title).toBe('On now')
    expect(markers[0].isCurrent).toBe(true)
    expect(markers[0].startFraction).toBeCloseTo(0.75, 10)
    expect(markers[0].endFraction).toBeCloseTo(1, 10)
  })

  it('orders multiple programmes left to right even when the listings arrive unordered', () => {
    const markers = buildCatchupTimeline(
      { startMs: NOW - 3 * HOUR, endMs: NOW },
      [
        programme((NOW - HOUR) / 1000, (NOW - 10 * MIN) / 1000, 'Second half'),
        programme((NOW - 3 * HOUR) / 1000, (NOW - HOUR) / 1000, 'First half')
      ],
      NOW
    )
    expect(markers.map((m) => m.title)).toEqual(['First half', 'Second half'])
    // Back-to-back programmes meet exactly at the shared boundary — no gap, no overlap.
    expect(markers[0].endFraction).toBeCloseTo(markers[1].startFraction, 10)
    // The just-ended programme is not the current one — now sits in the gap/upcoming slot.
    expect(markers[1].isCurrent).toBe(false)
  })

  it('returns an honest empty list for no programmes, an inverted window, or unparseable stamps', () => {
    const window = { startMs: NOW - HOUR, endMs: NOW }
    expect(buildCatchupTimeline(window, [], NOW)).toEqual([])
    expect(buildCatchupTimeline({ startMs: NOW, endMs: NOW - HOUR }, [programme(0, 1)], NOW)).toEqual([])
    expect(
      buildCatchupTimeline(window, [{ ...programme(0, 1), start_timestamp: 'not-a-number' }], NOW)
    ).toEqual([])
  })

  it('labels a blank title rather than rendering an unnamed marker', () => {
    const markers = buildCatchupTimeline(
      { startMs: NOW - HOUR, endMs: NOW },
      [programme((NOW - HOUR) / 1000, NOW, '')],
      NOW
    )
    expect(markers[0].title).toBe('Untitled programme')
  })
})

describe('windowExtentLabel', () => {
  it('formats a deep archive window in hours to one decimal', () => {
    expect(windowExtentLabel({ startMs: NOW - 3.2 * HOUR, endMs: NOW }, NOW)).toBe('3.2h behind live')
    expect(windowExtentLabel({ startMs: NOW - HOUR, endMs: NOW }, NOW)).toBe('1.0h behind live')
  })

  it('formats a shallow window in whole minutes, floored', () => {
    expect(windowExtentLabel({ startMs: NOW - 150_000, endMs: NOW }, NOW)).toBe('2m behind live')
    expect(windowExtentLabel({ startMs: NOW - 59 * MIN, endMs: NOW }, NOW)).toBe('59m behind live')
  })

  it('says "at live" when the window has no meaningful depth', () => {
    // Just under the threshold — live-edge slack, not a catch-up window.
    expect(windowExtentLabel({ startMs: NOW - WINDOW_EXTENT_MIN_MS + 1, endMs: NOW }, NOW)).toBe('at live')
    // Exactly the threshold counts.
    expect(windowExtentLabel({ startMs: NOW - WINDOW_EXTENT_MIN_MS, endMs: NOW }, NOW)).toBe('1m behind live')
  })

  it('never counts buffer beyond now as reachable depth', () => {
    // A window whose end sits ahead of now (future slack) still labels by what's behind now.
    expect(windowExtentLabel({ startMs: NOW - HOUR, endMs: NOW + 10 * MIN }, NOW)).toBe('1.0h behind live')
  })

  it('says "at live" for the degenerate empty window', () => {
    expect(windowExtentLabel({ startMs: NOW, endMs: NOW }, NOW)).toBe('at live')
    expect(windowExtentLabel({ startMs: NOW, endMs: NOW - HOUR }, NOW)).toBe('at live')
  })
})
