import { describe, it, expect } from 'vitest'
import {
  PROGRAMME_DESCRIPTION_LIMIT,
  NO_DESCRIPTION_LABEL,
  buildProgrammeDetail,
  formatProgrammeTime,
  programmeDescriptionSnippet,
  programmeTimeRange,
  programmeWatchAction
} from './programmeDetail'
import type { ShortEpgProgram } from './types'

// A programme airing 18:30–19:00 on 2026-01-15 UTC, expressed as the provider's epoch-second
// strings — the shape shortEpgByStream actually carries (mockXtreamServer builds the same thing).
const START = String(Math.floor(Date.UTC(2026, 0, 15, 18, 30, 0) / 1000))
const STOP = String(Math.floor(Date.UTC(2026, 0, 15, 19, 0, 0) / 1000))

function programme(overrides: Partial<ShortEpgProgram> = {}): ShortEpgProgram {
  return {
    id: 'programme-1',
    epg_id: '1',
    title: "Two's Next",
    lang: 'en',
    start: '',
    end: '',
    description: "The fixture guide's upcoming programme.",
    channel_id: 'two.uk',
    start_timestamp: START,
    stop_timestamp: STOP,
    ...overrides
  }
}

describe('programmeTimeRange', () => {
  it("joins the two ends with the tooltip's en dash", () => {
    const range = programmeTimeRange(START, STOP, '24h')
    const parts = range.split(' – ')
    expect(parts).toHaveLength(2)
    // 24h formatting is hour12:false in every locale: plain hour:minute with no day period.
    for (const part of parts) expect(part).toMatch(/^\d{1,2}:\d{2}$/)
  })

  it('shapes both ends with the clock setting (12h differs from 24h for an afternoon slot)', () => {
    const twelve = programmeTimeRange(START, STOP, '12h')
    const twentyFour = programmeTimeRange(START, STOP, '24h')
    expect(twelve).not.toBe(twentyFour)
    expect(twelve.split(' – ')).toHaveLength(2)
  })

  it('matches formatProgrammeTime for each end', () => {
    expect(programmeTimeRange(START, STOP, '24h')).toBe(
      `${formatProgrammeTime(START, '24h')} – ${formatProgrammeTime(STOP, '24h')}`
    )
  })
})

describe('programmeDescriptionSnippet', () => {
  it('returns the whole description when it fits the limit', () => {
    const text = 'A short one.'
    expect(programmeDescriptionSnippet(text)).toBe(text)
  })

  it('truncates long descriptions to the limit with an ellipsis', () => {
    const text = 'x'.repeat(PROGRAMME_DESCRIPTION_LIMIT + 50)
    const snippet = programmeDescriptionSnippet(text)
    expect(snippet).not.toBeNull()
    expect(snippet!.length).toBeLessThanOrEqual(PROGRAMME_DESCRIPTION_LIMIT + 1)
    expect(snippet!.endsWith('…')).toBe(true)
  })

  it('trims provider whitespace, and empty/blank descriptions honestly return null', () => {
    expect(programmeDescriptionSnippet('  padded  ')).toBe('padded')
    expect(programmeDescriptionSnippet('')).toBeNull()
    expect(programmeDescriptionSnippet('   \n  ')).toBeNull()
    expect(NO_DESCRIPTION_LABEL.length).toBeGreaterThan(0)
  })
})

describe('programmeWatchAction', () => {
  const now = Number(STOP) * 1000 + 60_000 // a minute after the programme ended

  it('catches up a past programme on an archived channel', () => {
    expect(programmeWatchAction(programme(), { tv_archive: 1 }, now)).toBe('catchup')
  })

  it('keeps a past programme on a non-archived channel an ordinary watch (nothing to catch up on)', () => {
    expect(programmeWatchAction(programme(), { tv_archive: 0 }, now)).toBe('watch')
  })

  it('watches a programme that is still running or upcoming even with archive', () => {
    const during = Number(START) * 1000 + 60_000
    expect(programmeWatchAction(programme(), { tv_archive: 1 }, during)).toBe('watch')
    expect(programmeWatchAction(programme(), { tv_archive: 1 }, Number(START) * 1000 - 60_000)).toBe('watch')
  })

  it('treats the exact stop second as past (the click rule this replaces)', () => {
    expect(programmeWatchAction(programme(), { tv_archive: 1 }, Number(STOP) * 1000)).toBe('catchup')
  })
})

describe('buildProgrammeDetail', () => {
  const now = Number(START) * 1000 - 60_000 // a minute before it starts

  it("assembles the popover's content for an upcoming programme", () => {
    const detail = buildProgrammeDetail(programme(), { tv_archive: 0, name: '101 Two HD' }, now, '24h')
    expect(detail.title).toBe("Two's Next")
    expect(detail.isUpcoming).toBe(true)
    expect(detail.watchLabel).toBe('Watch')
    expect(detail.watchAction).toBe('watch')
    expect(detail.description).toBe("The fixture guide's upcoming programme.")
    expect(detail.timeRange.split(' – ')).toHaveLength(2)
  })

  it('labels the catch-up case honestly for a past, archived programme', () => {
    const after = Number(STOP) * 1000 + 60_000
    const detail = buildProgrammeDetail(programme(), { tv_archive: 1, name: 'One HD' }, after, '24h')
    expect(detail.isUpcoming).toBe(false)
    expect(detail.watchAction).toBe('catchup')
    expect(detail.watchLabel).toBe('Catch-up')
  })

  it("falls back to the honest no-description label's trigger (null) when none exists", () => {
    const detail = buildProgrammeDetail(programme({ description: '' }), { tv_archive: 0, name: 'One HD' }, now, '24h')
    expect(detail.description).toBeNull()
  })
})
