import type { VpnStatus } from './types'

// A connected tunnel dropping is only worth an unprompted warning when it wasn't the user's own
// doing — Deactivate and switching to a different profile both tear down the current tunnel on
// purpose and look identical from the outside (a "connected" -> non-connected transition), so
// intent has to be passed in explicitly rather than inferred from the status change alone.
export function shouldWarnOnVpnDisconnect(
  prevStatus: VpnStatus,
  newStatus: VpnStatus,
  disconnectingIntentionally: boolean
): boolean {
  return prevStatus === 'connected' && newStatus !== 'connected' && !disconnectingIntentionally
}
