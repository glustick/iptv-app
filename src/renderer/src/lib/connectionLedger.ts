/**
 * The connection ledger (0.43.0) — a session-scoped picture of who is holding a provider
 * connection, for the readouts that answer "why can't this play": the single-connection
 * account this app targets allows one origin stream at a time, and the honest failure modes
 * (Multi-View's ceiling, the recording conflict, a preview panel holding a slot) all reduce
 * to "someone else has it". Until now that someone was invisible.
 *
 * Module-level, like recoveryLog: the writers are the components that actually open streams
 * (Player, Multi-View tiles, the docked preview, the recording effect) and the readers are
 * render-time snapshots (the stats overlay's Connections row, Multi-View's blocked message)
 * that poll or re-render on their own schedules — no subscription plumbing for either side.
 *
 * Registration is by id so a holder that forgets to release (a quick channel switch mid-attach)
 * can never double-register; release is by the same id. The label is what the readouts show.
 */

export interface ConnectionHolder {
  id: string
  label: string
  /** Epoch ms the holder registered. */
  since: number
}

const holders = new Map<string, ConnectionHolder>()

export function registerConnectionHolder(id: string, label: string, now: number = Date.now()): void {
  holders.set(id, { id, label, since: now })
}

export function releaseConnectionHolder(id: string): void {
  holders.delete(id)
}

/** Registration order, oldest first — the readouts show it in the order the slots were taken. */
export function listConnectionHolders(): ConnectionHolder[] {
  return [...holders.values()].sort((a, b) => a.since - b.since)
}

/** The one-line summary the readouts render: each holder's label in order. */
export function describeConnectionHolders(): string {
  const list = listConnectionHolders()
  return list.length === 0 ? 'none' : list.map((h) => h.label).join(', ')
}
