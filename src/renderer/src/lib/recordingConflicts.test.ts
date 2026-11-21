import { describe, expect, it } from 'vitest'
import { findScheduleConflict, formatAirsIn, sortRecordingsForList } from './recordingConflicts'
import type { ScheduleConflictCandidate } from './recordingConflicts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = Date.parse('2026-11-21T12:00:00')

function scheduled(overrides: Partial<ScheduleConflictCandidate> = {}): ScheduleConflictCandidate {
  return {
    id: 'sch-1',
    programmeTitle: 'One Show',
    channelName: 'One HD',
    status: 'scheduled',
    startAt: now + 2 * HOUR,
    endAt: now + 3 * HOUR,
    ...overrides
  }
}

describe('findScheduleConflict', () => {
  it('detects a full overlap, a partial one from either side, and exact containment', () => {
    const existing = [scheduled()]
    expect(findScheduleConflict(existing, now + 2 * HOUR, now + 3 * HOUR)).not.toBeNull()
    expect(findScheduleConflict(existing, now + 2.5 * HOUR, now + 4 * HOUR)).not.toBeNull()
    expect(findScheduleConflict(existing, now + HOUR, now + 2.5 * HOUR)).not.toBeNull()
    expect(findScheduleConflict(existing, now + 1.9 * HOUR, now + 3.1 * HOUR)).not.toBeNull()
  })

  it('treats the window as half-open: touching endpoints are NOT a conflict', () => {
    const existing = [scheduled()] // [start, end) = [now+2h, now+3h)
    expect(findScheduleConflict(existing, now + HOUR, now + 2 * HOUR)).toBeNull()
    expect(findScheduleConflict(existing, now + 3 * HOUR, now + 4 * HOUR)).toBeNull()
  })

  it('returns null for windows entirely before or after the existing schedule', () => {
    const existing = [scheduled()]
    expect(findScheduleConflict(existing, now, now + HOUR)).toBeNull()
    expect(findScheduleConflict(existing, now + 5 * HOUR, now + 6 * HOUR)).toBeNull()
  })

  it('ignores non-scheduled entries even when their windows overlap', () => {
    const existing = [
      scheduled({ status: 'recording' }),
      scheduled({ status: 'done', id: 'sch-2' }),
      scheduled({ status: 'failed', id: 'sch-3' })
    ]
    expect(findScheduleConflict(existing, now + 2 * HOUR, now + 3 * HOUR)).toBeNull()
  })

  it('ignores scheduled entries without an air window (pre-0.34 index entries)', () => {
    const existing = [scheduled({ startAt: undefined, endAt: undefined })]
    expect(findScheduleConflict(existing, now + 2 * HOUR, now + 3 * HOUR)).toBeNull()
  })

  it('returns the conflicting entry itself, so the confirm can name it', () => {
    const hit = scheduled({ programmeTitle: 'The News' })
    expect(findScheduleConflict([scheduled({ startAt: now + 10 * HOUR, endAt: now + 11 * HOUR }), hit], now + 2.5 * HOUR, now + 4 * HOUR)).toBe(hit)
  })
})

describe('formatAirsIn', () => {
  it('says "any minute now" from five minutes out down to already-due', () => {
    expect(formatAirsIn(now + 4 * 60_000, now)).toBe('any minute now')
    expect(formatAirsIn(now, now)).toBe('any minute now')
    expect(formatAirsIn(now - 60_000, now)).toBe('any minute now')
  })

  it('keeps bare minutes under an hour', () => {
    expect(formatAirsIn(now + 5 * 60_000, now)).toBe('in 5m')
    expect(formatAirsIn(now + 59 * 60_000, now)).toBe('in 59m')
  })

  it('rounds hours-and-minutes between one hour and a day', () => {
    expect(formatAirsIn(now + 2 * HOUR + 15 * 60_000, now)).toBe('in 2h 15m')
    expect(formatAirsIn(now + 3 * HOUR, now)).toBe('in 3h')
    expect(formatAirsIn(now + 23 * HOUR + 59 * 60_000, now)).toBe('in 23h 59m')
  })

  it('rounds to whole days beyond a day', () => {
    expect(formatAirsIn(now + 3 * DAY, now)).toBe('in 3d')
    expect(formatAirsIn(now + 2 * DAY + 12 * HOUR, now)).toBe('in 3d')
  })
})

describe('sortRecordingsForList', () => {
  it('puts scheduled first by air time, then recording, then finished by recency', () => {
    const entries = [
      { id: 'done-old', status: 'done', startedAt: now - 3 * DAY, endedAt: now - 3 * DAY + HOUR },
      { id: 'rec', status: 'recording', startedAt: now - HOUR },
      { id: 'sch-later', status: 'scheduled', startedAt: now + 5 * HOUR, startAt: now + 5 * HOUR, endAt: now + 6 * HOUR },
      { id: 'done-new', status: 'done', startedAt: now - DAY, endedAt: now - DAY + HOUR },
      { id: 'sch-soon', status: 'scheduled', startedAt: now + HOUR, startAt: now + HOUR, endAt: now + 2 * HOUR }
    ]
    expect(sortRecordingsForList(entries).map((e) => e.id)).toEqual([
      'sch-soon',
      'sch-later',
      'rec',
      'done-new',
      'done-old'
    ])
  })

  it('sorts scheduled entries without an air window after the ones that have one', () => {
    const entries = [
      { id: 'sch-no-window', status: 'scheduled', startedAt: now + HOUR },
      { id: 'sch-window', status: 'scheduled', startedAt: now + 9 * HOUR, startAt: now + 9 * HOUR }
    ]
    expect(sortRecordingsForList(entries).map((e) => e.id)).toEqual(['sch-window', 'sch-no-window'])
  })

  it('groups partial and failed with done, most recent first, and never mutates the input', () => {
    const entries = [
      { id: 'failed-old', status: 'failed', startedAt: now - 4 * DAY, endedAt: now - 4 * DAY },
      { id: 'partial-new', status: 'partial', startedAt: now - HOUR, endedAt: now }
    ]
    const sorted = sortRecordingsForList(entries)
    expect(sorted.map((e) => e.id)).toEqual(['partial-new', 'failed-old'])
    expect(entries.map((e) => e.id)).toEqual(['failed-old', 'partial-new'])
  })
})
