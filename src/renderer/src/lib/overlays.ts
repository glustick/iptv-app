/**
 * The single Escape priority chain, as data rather than an if-else buried in App.tsx.
 *
 * Why it lives here: every overlay in this app is closed by one central document-level handler
 * (see App.tsx's own comment on why — two uncoordinated listeners racing on the same key was a
 * real bug once). That's the right design, but "add a new overlay" used to mean "remember to add
 * a branch to that chain", and twice in a row that didn't happen: My Categories (0.7.74) and the
 * update prompt (0.7.26) were both invisible to Escape — which didn't merely fail to close them,
 * it fell through to whatever was open *behind* them, closing the channel preview or stopping
 * playback instead. A component-rendering test could have caught it; this project has none, so
 * the chain is a pure function instead and the tests below pin the entire order.
 *
 * The order is outermost-first, which is what makes "the dialog you're looking at" win:
 *   1. the update prompt — can even sit over the login screen
 *   2. About — reachable at any time from the native menu, including mid-fullscreen
 *   3. the Guide & EPG surface (a sibling of Settings, never stacked with it, but listed first
 *      so the one that was opened most recently is the one Escape closes)
 *   4. Settings
 *   5. My Categories (a top-level modal like Settings)
 *   6. the parental PIN prompt
 *   7. the series detail modal
 *   8. the fullscreen channel-swap bar
 *   9. the player itself
 *   10. the docked channel preview
 * Fullscreen-exit is handled before any of this (in App.tsx) because fullscreen is the outermost
 * visual layer when active, and it's a browser API call rather than a store action.
 */
export interface OverlayState {
  updateInfo: unknown | null
  updateDismissed: boolean
  aboutOpen: boolean
  guideOpen: boolean
  settingsOpen: boolean
  customCategoriesOpen: boolean
  pinPromptCategoryId: string | null
  openSeries: unknown | null
  channelBarOpen: boolean
  nowPlaying: unknown | null
  previewChannel: unknown | null
}

export type OverlayEscapeAction =
  | 'dismissUpdate'
  | 'closeAbout'
  | 'closeGuide'
  | 'closeSettings'
  | 'closeCustomCategories'
  | 'cancelPinPrompt'
  | 'closeSeries'
  | 'closeChannelBar'
  | 'stopPlayback'
  | 'closePreview'

export function resolveEscapeAction(state: OverlayState): OverlayEscapeAction | null {
  if (state.updateInfo && !state.updateDismissed) return 'dismissUpdate'
  if (state.aboutOpen) return 'closeAbout'
  if (state.guideOpen) return 'closeGuide'
  if (state.settingsOpen) return 'closeSettings'
  if (state.customCategoriesOpen) return 'closeCustomCategories'
  if (state.pinPromptCategoryId) return 'cancelPinPrompt'
  if (state.openSeries) return 'closeSeries'
  if (state.channelBarOpen) return 'closeChannelBar'
  if (state.nowPlaying) return 'stopPlayback'
  if (state.previewChannel) return 'closePreview'
  return null
}
