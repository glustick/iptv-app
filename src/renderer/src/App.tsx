import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import { LoginScreen } from './components/LoginScreen'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { ChannelList } from './components/ChannelList'
import { Player } from './components/Player'
import { SeriesModal } from './components/SeriesModal'
import { EpgGridPanel } from './components/EpgGridPanel'
import { PinPrompt } from './components/PinPrompt'
import { SettingsPage } from './components/SettingsPage'

function App(): JSX.Element {
  const init = useAppStore((s) => s.init)
  const status = useAppStore((s) => s.status)
  const error = useAppStore((s) => s.error)
  const viewMode = useAppStore((s) => s.viewMode)

  useEffect(() => {
    init()
  }, [init])

  // Escape closes whichever non-player overlay is open, in front-to-back priority.
  // The Player has its own Escape handler (it also needs Space/arrow-key shortcuts
  // scoped to itself), so it's deliberately not duplicated here.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      const state = useAppStore.getState()
      if (state.settingsOpen) state.closeSettings()
      else if (state.pinPromptCategoryId) state.cancelPinPrompt()
      else if (state.openSeries) state.closeSeriesDetail()
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
      {error && <div className="banner-error banner-error--top">{error}</div>}
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
            <EpgGridPanel />
          </>
        )}
      </div>
      <Player />
      <SeriesModal />
      <PinPrompt />
      <SettingsPage />
    </div>
  )
}

export default App
