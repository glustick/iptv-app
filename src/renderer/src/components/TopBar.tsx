import { useAppStore, type ViewMode } from '../store/useAppStore'

const TABS: { mode: ViewMode; label: string }[] = [
  { mode: 'live', label: 'Live TV' },
  { mode: 'movies', label: 'Movies' },
  { mode: 'series', label: 'Series' },
  { mode: 'favorites', label: 'Favorites' }
]

export function TopBar(): JSX.Element {
  const viewMode = useAppStore((s) => s.viewMode)
  const setViewMode = useAppStore((s) => s.setViewMode)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const setSearchTerm = useAppStore((s) => s.setSearchTerm)
  const activeProfile = useAppStore((s) => s.activeProfile)
  const profiles = useAppStore((s) => s.profiles)
  const connect = useAppStore((s) => s.connect)
  const disconnect = useAppStore((s) => s.disconnect)
  const openSettings = useAppStore((s) => s.openSettings)
  const isOnline = useAppStore((s) => s.isOnline)

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

      {!isOnline && <span className="offline-badge">Offline</span>}

      <div className="profile-switcher">
        {profiles.length > 1 ? (
          <select
            className="profile-select"
            value={activeProfile?.id ?? ''}
            onChange={(e) => connect(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="profile-name">{activeProfile?.name}</span>
        )}
        <button className="icon-button" onClick={openSettings} title="Settings">
          ⚙
        </button>
        <button className="disconnect" onClick={disconnect}>
          Switch profile
        </button>
      </div>
    </header>
  )
}
