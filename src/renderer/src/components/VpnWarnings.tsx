import { useAppStore } from '../store/useAppStore'

// Mounted in both App.tsx and inside Player.tsx's own overlay: Player's overlay is a fixed,
// full-viewport layer (z-index 50, covers the whole app whenever something's playing, fullscreen
// or not — see .player-overlay), so this component being present in both places never shows
// twice at once, only wherever the user actually is when a warning fires. Stacked in a single
// fixed container (rather than each banner positioning itself) so a disconnect warning and a
// stream-route warning showing at the same time don't render on top of each other.
export function VpnWarnings(): JSX.Element | null {
  const disconnectMessage = useAppStore((s) => s.vpnDisconnectWarning)
  const dismissDisconnect = useAppStore((s) => s.dismissVpnDisconnectWarning)
  const streamRouteMessage = useAppStore((s) => s.vpnStreamRouteWarning)
  const dismissStreamRoute = useAppStore((s) => s.dismissVpnStreamRouteWarning)

  if (!disconnectMessage && !streamRouteMessage) return null

  return (
    <div className="vpn-warnings">
      {disconnectMessage && (
        <div className="vpn-warning">
          <span className="vpn-dot vpn-dot--error" />
          <span>{disconnectMessage}</span>
          <button className="vpn-warning-dismiss" onClick={dismissDisconnect}>
            ✕
          </button>
        </div>
      )}
      {streamRouteMessage && (
        <div className="vpn-warning">
          <span className="vpn-dot vpn-dot--error" />
          <span>{streamRouteMessage}</span>
          <button className="vpn-warning-dismiss" onClick={dismissStreamRoute}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
