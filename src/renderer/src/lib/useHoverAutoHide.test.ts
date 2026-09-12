import { describe, it, expect } from 'vitest'
import { reconcileHoverVisibility } from './useHoverAutoHide'

// The reconciliation core is what makes the "toolbar stuck hidden until app restart" class of
// bug impossible: every test below is a state the old transition-only mousemove check could
// reach live but never recover from, expressed against the pure decision function.
describe('reconcileHoverVisibility', () => {
  it('reveals when the cursor is in the zone and the overlay is hidden', () => {
    expect(reconcileHoverVisibility(true, false, false)).toEqual({ visible: true, suppressed: false })
  })

  it('keeps an explicit (click-to-hide) suppression while the cursor never leaves the zone', () => {
    // The click-to-toggle in Player.tsx hides the header while the cursor is still parked in
    // the reveal zone — twitches there must not instantly re-reveal it.
    expect(reconcileHoverVisibility(true, false, true)).toEqual({ visible: false, suppressed: true })
  })

  it('clears suppression once the cursor leaves the zone, so re-entry reveals again', () => {
    expect(reconcileHoverVisibility(false, false, true)).toEqual({ visible: false, suppressed: false })
    // ...and the very next in-zone event then reveals
    expect(reconcileHoverVisibility(true, false, false)).toEqual({ visible: true, suppressed: false })
  })

  it('never hides directly on a zone exit — hiding is the caller timer’s job', () => {
    expect(reconcileHoverVisibility(false, true, false)).toEqual({ visible: true, suppressed: false })
  })

  it('makes no change while in-zone and already visible', () => {
    expect(reconcileHoverVisibility(true, true, false)).toEqual({ visible: true, suppressed: false })
  })

  it('recovers from the old wedge state: hidden-but-still-marked-hovered', () => {
    // The pre-fix bug: an external hide (or an effect disable/enable cycle) left the overlay
    // hidden while internal hover state still said "in zone", so every subsequent in-zone
    // mousemove was treated as "nothing changed" and nothing ever re-revealed. Reconciliation
    // keyed on real visibility means the very next in-zone event reveals, whatever the
    // preceding state was.
    const afterExternalHide = reconcileHoverVisibility(true, false, false)
    expect(afterExternalHide.visible).toBe(true)
  })
})

// Kept from the original 0.7.56 fix: the zone predicate itself must classify the exact
// top-screen-edge coordinate (clientY 0) as inside the reveal zone — Windows fullscreen emits
// mouseout-with-no-relatedTarget there, and treating it as "left the zone" hid the toolbar.
describe('header reveal zone predicate', () => {
  it('correctly classifies top-edge boundary coordinates as within the zone', () => {
    const rect = { top: 0, bottom: 1080, left: 0, right: 1920, width: 1920, height: 1080 } as DOMRect

    const isInZone = (clientY: number): boolean => clientY < rect.top + Math.max(rect.height * 0.15, 90)

    // Top edge (clientY: 0) is well within the 162px reveal zone
    expect(isInZone(0)).toBe(true)
    // Mid-screen event (clientY: 500) is outside the reveal zone
    expect(isInZone(500)).toBe(false)
  })
})
