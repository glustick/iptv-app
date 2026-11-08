/**
 * How subtitles look — the web sibling's v0.89.0, which made cues the viewer's own instead of
 * whatever the browser decided. Per device, in the renderer's localStorage, for the same reason
 * the quality ceiling is: a phone at arm's length and a projector across a room do not want the
 * same cue size, and that is a fact about the room, not about the account.
 *
 * This app renders cues through the platform's own text-track renderer (hls.js feeds it, the
 * <video> paints it), so the styling is applied as `::cue` rules reading custom properties set on
 * the video element — the technique the web sibling proved in Chrome and Safari. Nothing here
 * draws a cue itself.
 *
 * Deliberately absent: position. The cue's line placement belongs to the browser's renderer, so a
 * "subtitles lower" control would change nothing while looking like it should.
 */

export const SUBTITLE_SIZES = [75, 100, 125, 150, 200] as const
export type SubtitleSize = (typeof SUBTITLE_SIZES)[number]

export type SubtitleColor = 'white' | 'yellow' | 'cyan'
export type SubtitleBox = 'none' | 'light' | 'solid'

export interface SubtitlePrefs {
  /** Percent of the size the browser would have used. */
  size: SubtitleSize
  color: SubtitleColor
  box: SubtitleBox
  /** A dark outline, so white text stays legible over a bright scene. */
  outline: boolean
}

// The closest thing to what the browser already drew before this panel existed: white text in a
// black box at the platform's own size. Opening the panel must not be the only way to get back to
// a normal-looking subtitle.
export const DEFAULT_SUBTITLE_PREFS: SubtitlePrefs = {
  size: 100,
  color: 'white',
  box: 'solid',
  outline: false
}

export const SUBTITLE_COLORS: Record<SubtitleColor, string> = {
  white: '#ffffff',
  yellow: '#ffe14d',
  cyan: '#7fe3ff'
}

export const SUBTITLE_COLOR_LABELS: Record<SubtitleColor, string> = {
  white: 'White',
  yellow: 'Yellow',
  cyan: 'Cyan'
}

export const SUBTITLE_BOX_LABELS: Record<SubtitleBox, string> = {
  none: 'None',
  light: 'Light',
  solid: 'Solid'
}

export function subtitleBackground(box: SubtitleBox): string {
  switch (box) {
    case 'none':
      return 'transparent'
    case 'light':
      return 'rgba(0, 0, 0, 0.45)'
    case 'solid':
      return '#000000'
  }
}

/** A crisp one-pixel outline all the way round, drawn with four offset shadows. */
export function subtitleTextShadow(outline: boolean): string {
  if (!outline) return 'none'
  return '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
}

const STORAGE_KEY = 'allisoniptv-subtitle-prefs'

function isSubtitleSize(value: unknown): value is SubtitleSize {
  return typeof value === 'number' && (SUBTITLE_SIZES as readonly number[]).includes(value)
}

function isSubtitleColor(value: unknown): value is SubtitleColor {
  return value === 'white' || value === 'yellow' || value === 'cyan'
}

function isSubtitleBox(value: unknown): value is SubtitleBox {
  return value === 'none' || value === 'light' || value === 'solid'
}

/**
 * Reads stored preferences, validating field by field — one corrupt field resets itself rather
 * than discarding the viewer's other three choices. Anything unreadable is the default.
 */
export function loadSubtitlePrefs(): SubtitlePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_SUBTITLE_PREFS
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SUBTITLE_PREFS
    const record = parsed as Record<string, unknown>
    return {
      size: isSubtitleSize(record.size) ? record.size : DEFAULT_SUBTITLE_PREFS.size,
      color: isSubtitleColor(record.color) ? record.color : DEFAULT_SUBTITLE_PREFS.color,
      box: isSubtitleBox(record.box) ? record.box : DEFAULT_SUBTITLE_PREFS.box,
      outline: typeof record.outline === 'boolean' ? record.outline : DEFAULT_SUBTITLE_PREFS.outline
    }
  } catch {
    return DEFAULT_SUBTITLE_PREFS
  }
}

export function saveSubtitlePrefs(prefs: SubtitlePrefs): void {
  try {
    const normalized: SubtitlePrefs = {
      size: isSubtitleSize(prefs.size) ? prefs.size : DEFAULT_SUBTITLE_PREFS.size,
      color: isSubtitleColor(prefs.color) ? prefs.color : DEFAULT_SUBTITLE_PREFS.color,
      box: isSubtitleBox(prefs.box) ? prefs.box : DEFAULT_SUBTITLE_PREFS.box,
      outline: prefs.outline === true
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // A blocked storage surface must not take playback down with it — the choice just does not
    // persist, exactly like the quality ceiling's own fallback.
  }
}

/**
 * The custom properties the `::cue` rule reads (see global.css). Set on the <video> element,
 * because a pseudo-element inherits from its originating element.
 */
export function subtitleCssVariables(prefs: SubtitlePrefs): Record<string, string> {
  return {
    '--cue-color': SUBTITLE_COLORS[prefs.color],
    '--cue-font-size': `${prefs.size}%`,
    '--cue-bg': subtitleBackground(prefs.box),
    '--cue-shadow': subtitleTextShadow(prefs.outline)
  }
}
