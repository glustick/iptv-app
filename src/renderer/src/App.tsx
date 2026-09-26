import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import { resolveEscapeAction } from './lib/overlays'
import { LoginScreen } from './components/LoginScreen'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { ChannelList } from './components/ChannelList'
import { Player } from './components/Player'
import { PlayerErrorBoundary } from './components/PlayerErrorBoundary'
import { SeriesModal } from './components/SeriesModal'
import { EpgGridPanel } from './components/EpgGridPanel'
import { MultiView } from './components/MultiView'
import { SportsView } from './components/SportsView'
import { PinPrompt } from './components/PinPrompt'
import { SettingsPage } from './components/SettingsPage'
import { GuideSettingsPage } from './components/GuideSettingsPage'
import { ChannelMatchModal } from './components/ChannelMatchModal'
import { CustomCategoriesModal } from './components/CustomCategoriesModal'
import { AboutModal } from './components/AboutModal'
import { VpnWarnings } from './components/VpnWarnings'
import { UpdatePrompt } from './components/UpdatePrompt'

function App(): JSX.Element {
  const init = useAppStore((s) => s.init)
  const status = useAppStore((s) => s.status)
  const error = useAppStore((s) => s.error)
  const viewMode = useAppStore((s) => s.viewMode)
  const openAbout = useAppStore((s) => s.openAbout)
  const retryConnection = useAppStore((s) => s.retryConnection)
  const checkEpgReminders = useAppStore((s) => s.checkEpgReminders)

  useEffect(() => {
    // init() catches its own errors internally (see useAppStore.ts) and always resolves —
    // nothing here needs to react to rejection, just to mark that intentionally for the
    // no-floating-promises lint rule.
    void init()
  }, [init])

  useEffect(() => {
    void checkEpgReminders()
    const interval = setInterval(() => void checkEpgReminders(), 30_000)
    return () => clearInterval(interval)
  }, [checkEpgReminders])

  // The About modal renders at App's root, outside the fullscreen player's own DOM subtree —
  // while truly fullscreen (the Fullscreen API only paints the fullscreened element and its
  // descendants, regardless of z-index — see .modal-overlay's own comment for the separate,
  // already-fixed windowed-mode stacking issue), opening it without exiting first would set
  // aboutOpen with nothing actually visible on screen to show for it. Reachable from the native
  // Help/App menu at any time, including mid-playback, unlike Settings (only ever opened via an
  // in-app button that isn't even rendered while fullscreen).
  useEffect(
    () =>
      window.api.app.onOpenAbout(() => {
        void (async () => {
          if (document.fullscreenElement) {
            await document.exitFullscreen().catch(() => {})
          }
          openAbout()
        })()
      }),
    [openAbout]
  )

  // The ONE place Escape is handled for every overlay, front-to-back — including the
  // fullscreen player and its channel-swap bar, both of which used to have their own
  // separate `document`-level listener in Player.tsx. Two uncoordinated listeners both
  // reacting to the same key was a real bug: neither stopped propagation, so both fired on
  // every press, and once previewChannel could legitimately stay set behind an open
  // fullscreen player, App's old handler would close the grid's preview out from under
  // Player's own bar-then-player Escape logic. Player.tsx now only listens for M/arrow-key
  // shortcuts (different keys entirely, so there's no possible overlap left to race).
  // channelBarOpen and nowPlaying both live in the store specifically so this single
  // handler can include them in the same priority chain as every other overlay.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      // Handled explicitly rather than relying solely on the browser's own native
      // "Escape exits fullscreen" shortcut — that's standard Chromium behavior outside the
      // page's own JS, but isn't guaranteed identical across every embedder/window-manager
      // combination, and fullscreen is the outermost visual layer when active, so it takes
      // priority over every other overlay below.
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
        return
      }
      // ...and the other kind: the *window* being fullscreen (macOS's own, which the app never
      // asks for but a system shortcut or a stray double-click can trigger) is invisible to
      // document.fullscreenElement, so without this Escape did nothing and the only way out was
      // closing the window — reported live. The main process no-ops this unless the window really
      // is natively fullscreen, so it costs nothing in the ordinary case.
      void window.api.app.exitFullScreen()
      const state = useAppStore.getState()
      // Which overlay Escape closes is decided by a pure function in lib/overlays.ts, where the
      // priority order is pinned by tests — "add an overlay, forget the chain" is exactly how the
      // update prompt and My Categories both ended up invisible to Escape (and fell through to
      // closing whatever was behind them). This switch only maps the decision to the store action.
      switch (resolveEscapeAction(state)) {
        case 'dismissUpdate':
          state.dismissUpdatePrompt()
          break
        case 'closeAbout':
          state.closeAbout()
          break
        case 'closeChannelMatch':
          state.closeChannelMatch()
          break
        case 'closeGuide':
          state.closeGuide()
          break
        case 'closeSettings':
          state.closeSettings()
          break
        case 'closeCustomCategories':
          state.closeCustomCategories()
          break
        case 'cancelPinPrompt':
          state.cancelPinPrompt()
          break
        case 'closeSeries':
          state.closeSeriesDetail()
          break
        case 'closeChannelBar':
          state.setChannelBarOpen(false)
          break
        case 'stopPlayback':
          state.stop()
          break
        case 'closePreview':
          state.closeChannelPreview()
          break
        case null:
          break
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  if (status !== 'ready') {
    return (
      <>
        <LoginScreen />
        <UpdatePrompt />
      </>
    )
  }

  return (
    <div className="app-shell">
      <TopBar />
      {error && (
        <div className="banner-error banner-error--top">
          <span>{error}</span>
          <button className="banner-error-retry" onClick={() => void retryConnection()}>
            Retry
          </button>
        </div>
      )}
      <div className="app-body">
        <Sidebar />
        {viewMode === 'live' ? (
          // The EPG grid's own channel column already lists every channel, so on the
          // Live TV tab it replaces the separate list entirely instead of sitting docked
          // beside it — no point browsing the same channels twice.
          <EpgGridPanel fullWidth />
        ) : viewMode === 'multiview' ? (
          // Sidebar (category selection) stays mounted and visible here on purpose — its
          // selected category is what scopes liveStreams for MultiView's own channel picker,
          // the same way it already does for the Live TV tab itself.
          <MultiView />
        ) : viewMode === 'sports' ? (
          <SportsView />
        ) : (
          <>
            <main className="content-area">
              <ChannelList />
            </main>
            {/* Only Favorites can ever populate previewChannel here (clicking a live
                favorite calls openChannelPreview) — Movies/Series never do, so the panel
                would just sit there empty, eating width the grid could use instead. */}
            {viewMode === 'favorites' && <EpgGridPanel />}
          </>
        )}
      </div>
      <PlayerErrorBoundary>
        <Player />
      </PlayerErrorBoundary>
      <SeriesModal />
      <PinPrompt />
      <SettingsPage />
      <GuideSettingsPage />
      <ChannelMatchModal />
      <CustomCategoriesModal />
      <AboutModal />
      <VpnWarnings />
      <UpdatePrompt />
    </div>
  )
}

export default App
