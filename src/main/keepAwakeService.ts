export interface KeepAwakeServiceDeps {
  // Injected rather than imported from 'electron' so this service stays unit-testable in a
  // plain node environment (vitest runs without Electron) — the same factory-injection
  // convention as transcodeService/proxyServer/vpnRecoveryService.
  startBlocker: (type: 'prevent-display-sleep') => number
  stopBlocker: (id: number) => void
  isBlockerStarted: (id: number) => boolean
}

export function createKeepAwakeService(deps: KeepAwakeServiceDeps) {
  let blockerId: number | null = null

  return {
    setEnabled(enabled: boolean): void {
      if (enabled) {
        // Idempotent: repeated enable calls (the renderer's effect re-runs on unrelated state
        // changes) must not stack blockers — an OS-level display-sleep assertion per call
        // would otherwise accumulate for the lifetime of the app.
        if (blockerId !== null && deps.isBlockerStarted(blockerId)) return
        blockerId = deps.startBlocker('prevent-display-sleep')
      } else if (blockerId !== null) {
        // isBlockerStarted also covers the case where the blocker was stopped out from under
        // us (app teardown paths) — stopping an already-dead id is a no-op anyway, but
        // skipping it keeps the injected-fake call log in tests honest.
        if (deps.isBlockerStarted(blockerId)) deps.stopBlocker(blockerId)
        blockerId = null
      }
    },

    isActive(): boolean {
      return blockerId !== null && deps.isBlockerStarted(blockerId)
    }
  }
}
