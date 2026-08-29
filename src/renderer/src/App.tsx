import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import { LoginScreen } from './components/LoginScreen'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { ChannelList } from './components/ChannelList'
import { Player } from './components/Player'
import { PlayerErrorBoundary } from './components/PlayerErrorBoundary'
import { SeriesModal } from './components/SeriesModal'
import { EpgGridPanel } from './components/EpgGridPanel'
import { PinPrompt } from './components/PinPrompt'
import { SettingsPage } from './components/SettingsPage'
import { AboutModal } from './components/AboutModal'
import { VpnWarnings } from './components/VpnWarnings'

function App(): JSX.Element {
  const init = useAppStore((s) => s.init)
  const status = useAppStore((s) => s.status)
  const error = useAppStore((s) => s.error)
  const viewMode = useAppStore((s) => s.viewMode)
  const openAbout = useAppStore((s) => s.openAbout)
  const retryConnection = useAppStore((s) => s.retryConnection)

  useEffect(() => {
    // init() catches its own errors internally (see useAppStore.ts) and always resolves —
    // nothing here needs to react to rejection, just to mark that intentionally for the
    // no-floating-promises lint rule.
    void init()
  }, [init])

  useEffect(() => window.api.app.onOpenAbout(openAbout), [openAbout])

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
      const state = useAppStore.getState()
      if (state.aboutOpen) state.closeAbout()
      else if (state.settingsOpen) state.closeSettings()
      else if (state.pinPromptCategoryId) state.cancelPinPrompt()
      else if (state.openSeries) state.closeSeriesDetail()
      else if (state.channelBarOpen) state.setChannelBarOpen(false)
      else if (state.nowPlaying) state.stop()
      else if (state.previewChannel) state.closeChannelPreview()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  if (status !== 'ready') {
    return <LoginScreen />
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
      <AboutModal />
      <VpnWarnings />
    </div>
  )
}

export default App
