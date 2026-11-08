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
  /** A patch, not a whole object: building "the new prefs" from the props here would let two
   *  changes in one React batch each start from the same stale values, so the second silently
   *  undid the first. The owner merges and persists. */
  onChange: (patch: Partial<SubtitlePrefs>) => void
  onClose: () => void
}

const COLORS: SubtitleColor[] = ['white', 'yellow', 'cyan']
const BOXES: SubtitleBox[] = ['none', 'light', 'solid']

/**
 * The viewer's own subtitle appearance — the web sibling's v0.89.0 panel, in this app's player.
 *
 * The preview is not decoration: a live cue only appears when someone is talking, so without a
 * sample the panel would be a set of controls with no visible effect until the next line. It is
 * styled from the same values the ::cue rule reads, so what it shows is what the cue will do.
 */
export function SubtitleStylePanel({ prefs, onChange, onClose }: Props): JSX.Element {
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
    </div>
  )
}
