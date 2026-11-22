import type { ClockFormat, LiveStream, ShortEpgProgram } from './types'

/**
 * Content shaping for the programme-detail popover (0.45.0): the grid's single-click now opens
 * a small panel describing the programme instead of acting on it right away, and everything the
 * panel says — the time range, the possibly-absent description, which action its button offers —
 * is decided here rather than inline in EpgGrid, so the wording and the catch-up rule are
 * unit-testable in jsdom (the grid's rows are virtualized and render nothing there).
 *
 * The watch rule is deliberately the SAME one the block's click has always applied (EpgGrid's
 * canCatchUp: past AND the channel carries catch-up archive): the popover's button must never
 * offer something the direct click wouldn't have done.
 */

/** How much of a description the popover shows before it stops — longer text simply ends with
 *  an ellipsis; the full text is still on the block's native tooltip. */
export const PROGRAMME_DESCRIPTION_LIMIT = 200

/** What the popover says when a programme genuinely has no description — an honest empty state
 *  rather than a blank block that reads as a rendering bug. */
export const NO_DESCRIPTION_LABEL = 'No description available.'

/** Same formatting the grid's tooltip has always used (hour + minutes, honouring the clock
 *  setting) — moved here so the popover's time range and the tooltip can't drift apart. */
export function formatProgrammeTime(epochSeconds: string, clockFormat: ClockFormat): string {
  return new Date(Number(epochSeconds) * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: clockFormat === '12h'
  })
}

/** The popover's "start – end" line. Both ends go through formatProgrammeTime, so a 12h/24h
 *  setting shapes both, and the en dash matches the tooltip's separator. */
export function programmeTimeRange(
  startTimestamp: string,
  stopTimestamp: string,
  clockFormat: ClockFormat
): string {
  return `${formatProgrammeTime(startTimestamp, clockFormat)} – ${formatProgrammeTime(stopTimestamp, clockFormat)}`
}

/** First ~PROGRAMME_DESCRIPTION_LIMIT characters of the description, whitespace-trimmed so a
 *  provider's lead-in newlines don't render as an empty-looking block. Returns null when there
 *  is nothing usable — the popover renders NO_DESCRIPTION_LABEL for that, not silence. */
export function programmeDescriptionSnippet(
  description: string,
  limit: number = PROGRAMME_DESCRIPTION_LIMIT
): string | null {
  const trimmed = description.trim()
  if (!trimmed) return null
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit).trimEnd()}…`
}

/**
 * Which action the popover's button offers — and the block's second click takes — for this
 * programme. `catchup` (a past programme on an archived channel) plays from the start via the
 * timeshift path exactly as the direct click always did; `watch` is the ordinary select. A past
 * programme on a NON-archived channel is still 'watch': selecting it is the honest best the data
 * allows (there is nothing to catch up on), matching today's click.
 */
export type ProgrammeWatchAction = 'catchup' | 'watch'

export function programmeWatchAction(
  program: ShortEpgProgram,
  channel: Pick<LiveStream, 'tv_archive'>,
  nowMs: number
): ProgrammeWatchAction {
  const isPast = Number(program.stop_timestamp) * 1000 <= nowMs
  return isPast && channel.tv_archive === 1 ? 'catchup' : 'watch'
}

/** Everything the popover renders, decided once — the component only places it on screen. */
export interface ProgrammeDetail {
  title: string
  timeRange: string
  /** The truncated description, or null when the programme has none (render NO_DESCRIPTION_LABEL). */
  description: string | null
  /** True when the programme starts after `nowMs` — the only state where remind/record make sense. */
  isUpcoming: boolean
  watchLabel: 'Watch' | 'Catch-up'
  watchAction: ProgrammeWatchAction
}

export function buildProgrammeDetail(
  program: ShortEpgProgram,
  channel: Pick<LiveStream, 'tv_archive' | 'name'>,
  nowMs: number,
  clockFormat: ClockFormat
): ProgrammeDetail {
  const watchAction = programmeWatchAction(program, channel, nowMs)
  return {
    title: program.title,
    timeRange: programmeTimeRange(program.start_timestamp, program.stop_timestamp, clockFormat),
    description: programmeDescriptionSnippet(program.description),
    isUpcoming: Number(program.start_timestamp) * 1000 > nowMs,
    watchLabel: watchAction === 'catchup' ? 'Catch-up' : 'Watch',
    watchAction
  }
}
