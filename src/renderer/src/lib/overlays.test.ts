import { describe, it, expect } from 'vitest'
import { resolveEscapeAction, type OverlayEscapeAction, type OverlayState } from './overlays'

const base: OverlayState = {
  updateInfo: null,
  updateDismissed: false,
  aboutOpen: false,
  shortcutsOpen: false,
  guideOpen: false,
  channelMatchOpen: false,
  settingsOpen: false,
  customCategoriesOpen: false,
  pinPromptCategoryId: null,
  openSeries: null,
  subtitleStyleOpen: false,
  programmeDetailOpen: false,
  miniPlayer: false,
  channelBarOpen: false,
  nowPlaying: null,
  previewChannel: null
}

/** The overlay fields, in the order Escape must resolve them (outermost first). */
const ORDER: Array<{ key: keyof OverlayState; action: OverlayEscapeAction; on: unknown }> = [
  { key: 'updateInfo', action: 'dismissUpdate', on: { version: '1.2.3' } },
  { key: 'aboutOpen', action: 'closeAbout', on: true },
  { key: 'shortcutsOpen', action: 'closeShortcuts', on: true },
  { key: 'channelMatchOpen', action: 'closeChannelMatch', on: true },
  { key: 'guideOpen', action: 'closeGuide', on: true },
  { key: 'settingsOpen', action: 'closeSettings', on: true },
  { key: 'customCategoriesOpen', action: 'closeCustomCategories', on: true },
  { key: 'pinPromptCategoryId', action: 'cancelPinPrompt', on: 'live:12' },
  { key: 'openSeries', action: 'closeSeries', on: { series_id: 1 } },
  { key: 'subtitleStyleOpen', action: 'closeSubtitleStyle', on: true },
  // 0.45.0: the grid's programme-detail popover resolves before the channel-swap bar (it floats
  // above a grid that renders inside that bar) and before the mini-player restores (the popover
  // is what the user just clicked; the card is a player layout mode).
  { key: 'programmeDetailOpen', action: 'closeProgrammeDetail', on: true },
  { key: 'miniPlayer', action: 'restorePlayer', on: true },
  { key: 'channelBarOpen', action: 'closeChannelBar', on: true },
  { key: 'nowPlaying', action: 'stopPlayback', on: { kind: 'live' } },
  { key: 'previewChannel', action: 'closePreview', on: { stream_id: 4 } }
]

describe('resolveEscapeAction', () => {
  it('does nothing when no overlay is open', () => {
    expect(resolveEscapeAction(base)).toBeNull()
  })

  it('closes each overlay on its own', () => {
    for (const { key, action, on } of ORDER) {
      expect(resolveEscapeAction({ ...base, [key]: on })).toBe(action)
    }
  })

  it('always targets the outermost open overlay, whatever combination is open', () => {
    // Open the layers innermost-first, asserting after each step that Escape targets the newest
    // (outermost) one. This is the property the two real bugs violated: they fell *through* an
    // open dialog instead of stopping at it.
    let state: OverlayState = base
    const observed: OverlayEscapeAction[] = []
    for (const { key, action, on } of [...ORDER].reverse()) {
      state = { ...state, [key]: on }
      expect(resolveEscapeAction(state)).toBe(action)
      observed.unshift(action)
    }
    // …and the collected resolution order is the declared one, outermost first.
    expect(observed).toEqual(ORDER.map((o) => o.action))
  })

  it('ignores an update prompt that has already been dismissed', () => {
    expect(resolveEscapeAction({ ...base, updateInfo: { version: '1.2.3' }, updateDismissed: true })).toBeNull()
    // …but a dismissed prompt must not block the overlay underneath it.
    expect(
      resolveEscapeAction({ ...base, updateInfo: { version: '1.2.3' }, updateDismissed: true, previewChannel: { stream_id: 1 } })
    ).toBe('closePreview')
  })

  it('Escape restores the mini card rather than stopping the stream it is still playing (0.28.0)', () => {
    expect(resolveEscapeAction({ ...base, miniPlayer: true, nowPlaying: { kind: 'live' } })).toBe('restorePlayer')
  })

  it('Escape closes the programme popover before the channel bar it floats over (0.45.0)', () => {
    // The popover opens on blocks inside the channel-swap bar's grid: falling through to the bar
    // would swap the channel underneath while the popover stayed open.
    expect(resolveEscapeAction({ ...base, programmeDetailOpen: true, channelBarOpen: true })).toBe('closeProgrammeDetail')
    // ...and before the docked preview behind it closes, and before playback stops.
    expect(resolveEscapeAction({ ...base, programmeDetailOpen: true, previewChannel: { stream_id: 4 } })).toBe('closeProgrammeDetail')
    expect(resolveEscapeAction({ ...base, programmeDetailOpen: true, nowPlaying: { kind: 'live' } })).toBe('closeProgrammeDetail')
  })

  it('closes the manager rather than the thing behind it (the 0.7.81 bug)', () => {
    expect(
      resolveEscapeAction({ ...base, customCategoriesOpen: true, previewChannel: { stream_id: 1 }, nowPlaying: { kind: 'live' } })
    ).toBe('closeCustomCategories')
  })
})
