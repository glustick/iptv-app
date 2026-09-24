import { describe, expect, it } from 'vitest'
import { createReminder, isReminderDue, reminderId, splitDueReminders, type EpgReminder } from './reminders'
import type { ShortEpgProgram } from './types'

const program: ShortEpgProgram = {
  id: 'programme-1',
  epg_id: 'epg-1',
  title: 'Evening News',
  lang: 'en',
  start: '',
  end: '',
  description: '',
  channel_id: 'channel-1',
  start_timestamp: '1100',
  stop_timestamp: '4700'
}

function reminder(overrides: Partial<EpgReminder> = {}): EpgReminder {
  return { ...createReminder(42, 'News One', program), ...overrides }
}

describe('EPG reminders', () => {
  it('uses a stable channel/programme key and stores the programme details', () => {
    expect(reminderId(42, 'programme-1')).toBe('42:programme-1')
    expect(createReminder(42, 'News One', program)).toMatchObject({
      id: '42:programme-1',
      channelName: 'News One',
      programTitle: 'Evening News',
      notifiedAt: null
    })
  })

  it('is due within the five-minute lead window and not after notification', () => {
    expect(isReminderDue(reminder(), 800_000)).toBe(true)
    expect(isReminderDue(reminder(), 799_000)).toBe(false)
    expect(isReminderDue(reminder({ notifiedAt: 1 }), 800_000)).toBe(false)
  })

  it('returns due reminders while pruning expired entries', () => {
    const result = splitDueReminders(
      [reminder(), reminder({ id: 'expired', endTimestamp: '700' }), reminder({ id: 'later', startTimestamp: '2000' })],
      800_000
    )
    expect(result.due.map((entry) => entry.id)).toEqual(['42:programme-1'])
    expect(result.active.map((entry) => entry.id)).toEqual(['42:programme-1', 'later'])
  })
})

describe('reminders across playlists', () => {
  it('keeps the historical id for a primary-playlist channel', () => {
    expect(reminderId(42, 'programme-1', 'primary', 'primary')).toBe('42:programme-1')
    // And for a channel whose playlist isn't known at all — every reminder written before
    // multi-playlist, which must keep matching.
    expect(reminderId(42, 'programme-1')).toBe('42:programme-1')
  })

  it("qualifies another playlist's channel, so the same id there is a different reminder", () => {
    const other = createReminder(42, 'B News', program, 'second', 'primary')
    expect(other.id).toBe('second:42:programme-1')
    expect(other.playlistId).toBe('second')
    // A single-playlist install passes no playlistId at all — channels are only tagged with one
    // when more than one playlist is connected — so the reminder it writes is byte-identical to the
    // one this app has always written: no extra field, and the bare id.
    const single = createReminder(42, 'A News', program)
    expect(single.playlistId).toBeUndefined()
    expect(single.id).toBe('42:programme-1')
  })
})
