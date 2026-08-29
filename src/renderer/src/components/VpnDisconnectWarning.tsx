import { useAppStore } from '../store/useAppStore'

// Mounted in both App.tsx and inside Player.tsx's own overlay: Player's overlay is a fixed,
// full-viewport layer (z-index 50, covers the whole app whenever something's playing, fullscreen
// or not — see .player-overlay), so this component being present in both places never shows
// twice at once, only wherever the user actually is when the tunnel drops.
export function VpnDisconnectWarning(): JSX.Element | null {
  const message = useAppStore((s) => s.vpnDisconnectWarning)
  const dismiss = useAppStore((s) => s.dismissVpnDisconnectWarning)

  if (!message) return null

  return (
    <div className="vpn-disconnect-warning">
      <span className="vpn-dot vpn-dot--error" />
      <span>{message}</span>
      <button className="vpn-disconnect-warning-dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
}
