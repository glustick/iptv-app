import type { ShortEpgProgram } from './types'
import { channelKey } from './channelIdentity'

export const REMINDER_LEAD_MS = 5 * 60_000

export interface EpgReminder {
  id: string
  streamId: number
  // Which playlist the channel belongs to. Absent means the primary — what every reminder written
  // before multi-playlist meant, and what a reminder for a primary-playlist channel still stores,
  // so the id format below is unchanged for the common case.
  playlistId?: string
  channelName: string
  programId: string
  programTitle: string
  startTimestamp: string
  endTimestamp: string
  notifiedAt: number | null
}

/**
 * The identity of one reminder: the channel's key (see channelIdentity) plus the programme's id.
 * For a primary-playlist channel this is the `${streamId}:${programId}` it has always been, so
 * reminders already stored keep matching; a channel from another playlist is qualified, which is
 * what stops the same id on two playlists from sharing one reminder (setting a bell on one used to
 * mark — and toggle off — the other's).
 */
export function reminderId(
  streamId: number,
  programId: string,
  playlistId?: string | null,
  primaryPlaylistId?: string | null
): string {
  return `${channelKey(playlistId, streamId, primaryPlaylistId)}:${programId}`
}

export function createReminder(
  streamId: number,
  channelName: string,
  program: ShortEpgProgram,
  playlistId?: string | null,
  primaryPlaylistId?: string | null
): EpgReminder {
  return {
    id: reminderId(streamId, program.id, playlistId, primaryPlaylistId),
    streamId,
    ...(playlistId ? { playlistId } : {}),
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
