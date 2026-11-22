import {
  SUBTITLE_BOX_LABELS,
  SUBTITLE_COLORS,
  SUBTITLE_COLOR_LABELS,
  SUBTITLE_SIZES,
  subtitleBackground,
  subtitleTextShadow,
  type SubtitleBox,
  type SubtitleColor,
  type SubtitlePrefs,
  type SubtitleSize
} from '../lib/subtitleStyle'

interface Props {
  prefs: SubtitlePrefs
  /** This session's sync offset in ms (0 = off). The panel only displays it; the owner resets it
   *  on channel change and never persists it — a delay tuned to one stream's audio is wrong on
   *  the next one. */
  delayMs: number
  /** A patch, not a whole object: building "the new prefs" from the props here would let two
   *  changes in one React batch each start from the same stale values, so the second silently
   *  undid the first. The owner merges and persists. */
  onChange: (patch: Partial<SubtitlePrefs>) => void
  onDelayChange: (ms: number) => void
  onClose: () => void
}

const COLORS: SubtitleColor[] = ['white', 'yellow', 'cyan']
const BOXES: SubtitleBox[] = ['none', 'light', 'solid']

/** The stepped offsets the Sync row offers. Deliberately coarse: a sync fix is found by ear in
 *  one or two nudges, not dialed in. */
const SYNC_STEPS: readonly number[] = [-500, -100, 0, 100, 500]

/** The offset as the row shows it: signed for any non-zero value, plain Off at zero. */
export function formatSubtitleDelay(ms: number): string {
  if (ms === 0) return 'Off'
  return `${ms > 0 ? '+' : '-'}${Math.abs(ms)}ms`
}

/**
 * The viewer's own subtitle appearance — the web sibling's v0.89.0 panel, in this app's player —
 * plus 0.46.0's Sync row, which moves cues in TIME (positive = subtitles later, negative =
 * earlier) rather than how they look.
 *
 * The preview is not decoration: a live cue only appears when someone is talking, so without a
 * sample the panel would be a set of controls with no visible effect until the next line. It is
 * styled from the same values the ::cue rule reads, so what it shows is what the cue will do.
 */
export function SubtitleStylePanel({ prefs, delayMs, onChange, onDelayChange, onClose }: Props): JSX.Element {
  const previewCue: React.CSSProperties = {
    color: SUBTITLE_COLORS[prefs.color],
    backgroundColor: subtitleBackground(prefs.box),
    textShadow: subtitleTextShadow(prefs.outline),
    fontSize: `${prefs.size}%`
  }

  return (
    <div className="subtitle-style-panel" role="dialog" aria-label="Subtitle appearance">
      <div className="subtitle-style-header">
        <span className="subtitle-style-title">Subtitle appearance</span>
        <button className="subtitle-style-close" onClick={onClose} title="Close" aria-label="Close subtitle appearance">
          ✕
        </button>
      </div>

      <div className="subtitle-style-preview" aria-hidden="true">
        <span className="subtitle-style-preview-cue" style={previewCue}>
          The quick brown fox jumps over the lazy dog
        </span>
      </div>

      <label className="subtitle-style-row">
        <span>Size</span>
        <select
          className="subtitle-style-select"
          value={prefs.size}
          onChange={(e) => {
            const size = Number(e.target.value)
            if ((SUBTITLE_SIZES as readonly number[]).includes(size)) {
              onChange({ size: size as SubtitleSize })
            }
          }}
        >
          {SUBTITLE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}%
            </option>
          ))}
        </select>
      </label>

      <div className="subtitle-style-row">
        <span>Colour</span>
        <div className="subtitle-style-swatches">
          {COLORS.map((color) => (
            <button
              key={color}
              className={prefs.color === color ? 'subtitle-style-swatch active' : 'subtitle-style-swatch'}
              onClick={() => onChange({ color })}
              aria-pressed={prefs.color === color}
              aria-label={SUBTITLE_COLOR_LABELS[color]}
              title={SUBTITLE_COLOR_LABELS[color]}
            >
              <span className="subtitle-style-swatch-dot" style={{ backgroundColor: SUBTITLE_COLORS[color] }} />
              {SUBTITLE_COLOR_LABELS[color]}
            </button>
          ))}
        </div>
      </div>

      <label className="subtitle-style-row">
        <span>Box</span>
        <select
          className="subtitle-style-select"
          value={prefs.box}
          onChange={(e) => {
            const box = e.target.value
            if (box === 'none' || box === 'light' || box === 'solid') onChange({ box })
          }}
        >
          {BOXES.map((box) => (
            <option key={box} value={box}>
              {SUBTITLE_BOX_LABELS[box]}
            </option>
          ))}
        </select>
      </label>

      <label className="subtitle-style-row subtitle-style-check">
        <input
          type="checkbox"
          checked={prefs.outline}
          onChange={(e) => onChange({ outline: e.target.checked })}
        />
        <span>Outline the text (keeps white legible over a bright scene)</span>
      </label>

      <div className="subtitle-style-row">
        <span>Sync</span>
        <div className="subtitle-style-sync-group">
          {SYNC_STEPS.map((step) => (
            <button
              key={step}
              className={delayMs === step ? 'subtitle-style-sync-btn active' : 'subtitle-style-sync-btn'}
              onClick={() => onDelayChange(step)}
              aria-pressed={delayMs === step}
              title={
                step === 0
                  ? 'Subtitles in time with the audio'
                  : step > 0
                    ? `Subtitles ${step}ms later than the audio`
                    : `Subtitles ${Math.abs(step)}ms earlier than the audio`
              }
            >
              {formatSubtitleDelay(step)}
            </button>
          ))}
        </div>
      </div>
      <div className="subtitle-style-sync-current" role="status">
        {delayMs === 0
          ? 'Off — subtitles in time with the audio'
          : `Subtitles ${delayMs > 0 ? 'later' : 'earlier'} by ${Math.abs(delayMs)}ms (${formatSubtitleDelay(delayMs)})`}
      </div>
      {/* Honest about the boundary, so the row can't be mistaken for full A/V sync: the audio
          stream itself cannot be delayed here — Chromium offers no way to push a decoded audio
          track without a remux pipeline — so only the text moves. */}
      <p className="subtitle-style-sync-hint">
        Subtitles only — the audio stream cannot be delayed (a Chromium limitation), so this nudges
        the text toward the sound. The offset resets on channel change.
      </p>
    </div>
  )
}
