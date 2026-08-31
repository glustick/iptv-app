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
  const vpnHasProfiles = useAppStore((s) => s.settings.vpnProfiles.length > 0)
  const vpnStatus = useAppStore((s) => s.vpnStatus)
  const toggleVpnTunnel = useAppStore((s) => s.toggleVpnTunnel)

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

      {viewMode === 'live' && (
        // A hover-only title attribute on the input itself is easy to never discover — this
        // makes the limitation visible up front instead of only explaining it to someone who
        // happens to hover, since a search that silently "finds nothing" for an unbrowsed
        // channel's programme otherwise reads as a bug, not an API limitation.
        <span
          className="search-hint"
          title="Matches channel names, and programme titles for channels already scrolled into view"
        >
          ⓘ
        </span>
      )}

      {!isOnline && <span className="offline-badge">Offline</span>}

      {/* Stays visible whenever a VPN profile exists, even deactivated — a deliberate warning
          that traffic isn't tunneled right now, not just a "currently connecting" indicator
          that disappears the moment you're not actively using it. Doubles as an on/off toggle:
          connected or connecting reads as "on" and a click disconnects; disconnected or error
          reads as "off" and a click (re)connects to the last-active profile — see
          toggleVpnTunnel in the store. */}
      {vpnHasProfiles && (
        <button
          className={`vpn-dot-button vpn-dot vpn-dot--${vpnStatus}`}
          onClick={() => void toggleVpnTunnel()}
          title={
            vpnStatus === 'connected'
              ? 'VPN connected — click to disconnect'
              : vpnStatus === 'connecting'
                ? 'VPN connecting… — click to cancel'
                : vpnStatus === 'error'
                  ? 'VPN error — click to reconnect'
                  : 'VPN not connected — click to connect'
          }
        />
      )}

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
