import { describe, it, expect } from 'vitest'
import { createPlaylistStallTracker, STALL_LOADS, STALL_WINDOW_MS } from './playlistStall'

// The provider's placeholder shape: a live playlist whose window never changes across reloads,
// answering 200 every time. The tracker's job is to say "stalled" once, after enough identical
// reloads have spanned enough time — and never for a window that moves, however slowly.

const LOAD = { live: true, startSN: 100, endSN: 104 } as const

describe('createPlaylistStallTracker', () => {
  it('declares a stall exactly once after enough identical live reloads spanning the window', () => {
    const t = createPlaylistStallTracker()
    const step = STALL_WINDOW_MS / (STALL_LOADS - 1)
    let declared = false
    for (let i = 0; i < STALL_LOADS + 3; i++) {
      if (t.sample({ ...LOAD, at: 1_000 + i * step })) declared = true
    }
    expect(declared).toBe(true) // fires on the STALL_LOADS-th identical load
  })

  it('does not declare while the identical reloads are too recent', () => {
    const t = createPlaylistStallTracker()
    let declared = false
    // All loads crammed into a second — count reached, span not.
    for (let i = 0; i < 10; i++) {
      if (t.sample({ ...LOAD, at: 1_000 + i * 100 })) declared = true
    }
    expect(declared).toBe(false)
    // ...and a later identical load that finally spans the window still fires.
    expect(t.sample({ ...LOAD, at: 1_000 + STALL_WINDOW_MS + 500 })).toBe(true)
  })

  it('a window that advances never stalls, however slow', () => {
    const t = createPlaylistStallTracker()
    let declared = false
    for (let i = 0; i < 30; i++) {
      // One new segment every reload (a healthy live edge), checked over 10 minutes.
      if (t.sample({ live: true, startSN: 100 + i, endSN: 104 + i, at: 1_000 + i * 20_000 })) declared = true
    }
    expect(declared).toBe(false)
  })

  it('a slow provider that skips reloads but does advance never stalls', () => {
    const t = createPlaylistStallTracker()
    let declared = false
    // Two identical reloads, then the window moves — repeat for many cycles.
    for (let cycle = 0; cycle < 12; cycle++) {
      const base = 1_000 + cycle * 60_000
      if (t.sample({ live: true, startSN: 100 + cycle, endSN: 104 + cycle, at: base })) declared = true
      if (t.sample({ live: true, startSN: 100 + cycle, endSN: 104 + cycle, at: base + 15_000 })) declared = true
    }
    expect(declared).toBe(false)
  })

  it('a VOD playlist never stalls — a fixed window is what VOD means', () => {
    const t = createPlaylistStallTracker()
    let declared = false
    for (let i = 0; i < 10; i++) {
      if (t.sample({ live: false, startSN: 0, endSN: 499, at: 1_000 + i * 20_000 })) declared = true
    }
    expect(declared).toBe(false)
  })

  it('recovers: movement after near-stall resets the count', () => {
    const t = createPlaylistStallTracker()
    // Three identical loads (one short of the four required)…
    t.sample({ ...LOAD, at: 1_000 })
    t.sample({ ...LOAD, at: 11_000 })
    t.sample({ ...LOAD, at: 21_000 })
    // …then the window advances, then freezes again — the new freeze needs its own full run.
    t.sample({ live: true, startSN: 101, endSN: 105, at: 31_000 })
    let declared = false
    for (let i = 0; i < STALL_LOADS + 2; i++) {
      if (t.sample({ live: true, startSN: 101, endSN: 105, at: 41_000 + i * 12_000 })) declared = true
    }
    expect(declared).toBe(true)
    // And it fired only because the NEW window's own count and span were both met.
  })

  it('declares only once — later samples stay silent after the caller has acted', () => {
    const t = createPlaylistStallTracker()
    let fires = 0
    for (let i = 0; i < 20; i++) {
      if (t.sample({ ...LOAD, at: 1_000 + i * 12_000 })) fires += 1
    }
    expect(fires).toBe(1)
  })
})
