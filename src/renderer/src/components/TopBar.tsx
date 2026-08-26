import { useAppStore, type ViewMode } from '../store/useAppStore'

const TABS: { mode: ViewMode; label: string }[] = [
  { mode: 'live', label: 'Live TV' },
  { mode: 'movies', label: 'Movies' },
  { mode: 'series', label: 'Series' }
]

export function TopBar(): JSX.Element {
  const viewMode = useAppStore((s) => s.viewMode)
  const setViewMode = useAppStore((s) => s.setViewMode)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const setSearchTerm = useAppStore((s) => s.setSearchTerm)
  const activeProfile = useAppStore((s) => s.activeProfile)
  const disconnect = useAppStore((s) => s.disconnect)

  return (
    <header className="top-bar">
      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.mode}
            className={tab.mode === viewMode ? 'tab active' : 'tab'}
            onClick={() => setViewMode(tab.mode)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <input
        className="search-input"
        placeholder="Search…"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />

      <div className="profile-switcher">
        <span className="profile-name">{activeProfile?.name}</span>
        <button className="disconnect" onClick={disconnect}>
          Switch profile
        </button>
      </div>
    </header>
  )
}
