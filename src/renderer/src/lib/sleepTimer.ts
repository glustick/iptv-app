/**
 * The sleep timer's cycle — the web sibling's v0.90.0 timer plus its v0.94.0 addition, "stop when
 * this film ends".
 *
 * A pure cycle rather than an inline array in Player.tsx for the reason this project keeps
 * learning: the ordering and the labels are the whole behaviour, and they are testable here
 * without a video element. "End" is offered only for a title with a timeline — on live TV there is
 * nothing to end, and a mode that could never fire would be a lie in a button.
 */
export type SleepMode = number | 'end' | null

export const SLEEP_PRESETS_MINUTES = [15, 30, 60, 90] as const

export function sleepOptions(includeEnd: boolean): SleepMode[] {
  return includeEnd ? [null, 'end', ...SLEEP_PRESETS_MINUTES] : [null, ...SLEEP_PRESETS_MINUTES]
}

/** The next mode in the cycle, wrapping to off. An unknown current mode starts the cycle over. */
export function nextSleepMode(current: SleepMode, includeEnd: boolean): SleepMode {
  const options = sleepOptions(includeEnd)
  const index = options.indexOf(current)
  return options[(index + 1) % options.length]
}

export function sleepModeLabel(mode: SleepMode, remainingSeconds: number | null): string {
  if (mode === null) return 'Sleep Timer'
  if (mode === 'end') return 'Sleep: End of title'
  if (remainingSeconds !== null) {
    const minutes = Math.floor(remainingSeconds / 60)
    const seconds = remainingSeconds % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }
  return `${mode}m`
}
