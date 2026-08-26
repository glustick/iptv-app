import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import { LoginScreen } from './components/LoginScreen'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { ChannelList } from './components/ChannelList'
import { Player } from './components/Player'
import { SeriesModal } from './components/SeriesModal'

function App(): JSX.Element {
  const init = useAppStore((s) => s.init)
  const status = useAppStore((s) => s.status)
  const error = useAppStore((s) => s.error)

  useEffect(() => {
    init()
  }, [init])

  if (status !== 'ready') {
    return <LoginScreen />
  }

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <main className="content-area">
          {error && <div className="banner-error">{error}</div>}
          <ChannelList />
        </main>
      </div>
      <Player />
      <SeriesModal />
    </div>
  )
}

export default App
