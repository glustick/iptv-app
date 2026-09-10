import { describe, it, expect } from 'vitest'

describe('useHoverAutoHide', () => {
  it('correctly classifies top-edge boundary coordinates as within the zone', () => {
    const containerRef = {
      current: {
        getBoundingClientRect: () => ({ top: 0, bottom: 1080, left: 0, right: 1920, width: 1920, height: 1080 })
      } as unknown as HTMLElement
    }

    const isInZone = (e: MouseEvent, rect: DOMRect): boolean => e.clientY < rect.top + Math.max(rect.height * 0.15, 90)

    const topEdgeEvent = { clientY: 0, relatedTarget: null } as unknown as MouseEvent
    const rect = containerRef.current.getBoundingClientRect() as DOMRect

    // Top edge (clientY: 0) is well within the 162px reveal zone
    expect(isInZone(topEdgeEvent, rect)).toBe(true)

    // Mid-screen event (clientY: 500) is outside the reveal zone
    const midScreenEvent = { clientY: 500, relatedTarget: null } as unknown as MouseEvent
    expect(isInZone(midScreenEvent, rect)).toBe(false)
  })
})
