import { describe, it, expect } from 'vitest'
import { createKeepAwakeService, type KeepAwakeServiceDeps } from './keepAwakeService'

// Fake powerSaveBlocker recording every start/stop call, with an explicit "started" set the
// test controls — mirroring the real API's start()->id / stop(id) / isStarted(id) shape.
function makeFakeBlocker(): KeepAwakeServiceDeps & { startedIds: Set<number>; startCalls: number; stopCalls: number[] } {
  let nextId = 1
  const startedIds = new Set<number>()
  const fake = {
    startedIds,
    startCalls: 0,
    stopCalls: [] as number[],
    startBlocker: (_type: 'prevent-display-sleep'): number => {
      fake.startCalls += 1
      const id = nextId++
      startedIds.add(id)
      return id
    },
    stopBlocker: (id: number): void => {
      startedIds.delete(id)
      fake.stopCalls.push(id)
    },
    isBlockerStarted: (id: number): boolean => startedIds.has(id)
  }
  return fake
}

describe('createKeepAwakeService', () => {
  it('starts a display-sleep blocker on enable and reports active', () => {
    const fake = makeFakeBlocker()
    const service = createKeepAwakeService(fake)
    expect(service.isActive()).toBe(false)
    service.setEnabled(true)
    expect(fake.startCalls).toBe(1)
    expect(service.isActive()).toBe(true)
  })

  it('is idempotent while enabled — repeated enable calls never stack blockers', () => {
    const fake = makeFakeBlocker()
    const service = createKeepAwakeService(fake)
    service.setEnabled(true)
    service.setEnabled(true)
    service.setEnabled(true)
    expect(fake.startCalls).toBe(1)
  })

  it('stops the blocker on disable and is idempotent while disabled', () => {
    const fake = makeFakeBlocker()
    const service = createKeepAwakeService(fake)
    service.setEnabled(true)
    service.setEnabled(false)
    service.setEnabled(false)
    expect(fake.stopCalls).toHaveLength(1)
    expect(service.isActive()).toBe(false)
  })

  it('starts a fresh blocker on re-enable after a disable', () => {
    const fake = makeFakeBlocker()
    const service = createKeepAwakeService(fake)
    service.setEnabled(true)
    const firstId = fake.stopCalls // empty
    expect(firstId).toHaveLength(0)
    service.setEnabled(false)
    service.setEnabled(true)
    expect(fake.startCalls).toBe(2)
    expect(fake.stopCalls).toHaveLength(1)
    expect(service.isActive()).toBe(true)
  })

  it('does not stop an already-dead blocker id (external teardown) but still clears its record', () => {
    const fake = makeFakeBlocker()
    const service = createKeepAwakeService(fake)
    service.setEnabled(true)
    // Simulate something else (app teardown) having stopped the blocker out from under the
    // service — its recorded id is dead before setEnabled(false) ever runs.
    fake.startedIds.clear()
    service.setEnabled(false)
    expect(fake.stopCalls).toHaveLength(0)
    expect(service.isActive()).toBe(false)
    // And a subsequent enable works cleanly rather than trusting the stale id.
    service.setEnabled(true)
    expect(fake.startCalls).toBe(2)
    expect(service.isActive()).toBe(true)
  })
})
