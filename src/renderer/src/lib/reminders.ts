import type { ShortEpgProgram } from './types'

export const REMINDER_LEAD_MS = 5 * 60_000

export interface EpgReminder {
  id: string
  streamId: number
  channelName: string
  programId: string
  programTitle: string
  startTimestamp: string
  endTimestamp: string
  notifiedAt: number | null
}

export function reminderId(streamId: number, programId: string): string {
  return `${streamId}:${programId}`
}

export function createReminder(streamId: number, channelName: string, program: ShortEpgProgram): EpgReminder {
  return {
    id: reminderId(streamId, program.id),
    streamId,
    channelName,
    programId: program.id,
    programTitle: program.title,
    startTimestamp: program.start_timestamp,
    endTimestamp: program.stop_timestamp,
    notifiedAt: null
  }
}

export function isReminderDue(reminder: EpgReminder, nowMs: number, leadMs = REMINDER_LEAD_MS): boolean {
  const startMs = Number(reminder.startTimestamp) * 1000
  const endMs = Number(reminder.endTimestamp) * 1000
  return reminder.notifiedAt === null && startMs <= nowMs + leadMs && endMs > nowMs
}

export function splitDueReminders(
  reminders: EpgReminder[],
  nowMs: number,
  leadMs = REMINDER_LEAD_MS
): { due: EpgReminder[]; active: EpgReminder[] } {
  const due: EpgReminder[] = []
  const active: EpgReminder[] = []
  for (const reminder of reminders) {
    const endMs = Number(reminder.endTimestamp) * 1000
    if (endMs <= nowMs) continue
    active.push(reminder)
    if (isReminderDue(reminder, nowMs, leadMs)) due.push(reminder)
  }
  return { due, active }
}
