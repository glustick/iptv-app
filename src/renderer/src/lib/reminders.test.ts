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
