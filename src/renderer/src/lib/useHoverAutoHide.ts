import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Shows something instantly while the cursor is within a given zone of a container, and hides
 * it again after `autoHideMs` once the cursor leaves that zone — whether it moved elsewhere
 * within the container, or left the window/document entirely.
 *
 * The window-leave case is the one a plain position-driven `mousemove` handler can never see on
 * its own: no more `mousemove` events fire once the cursor is outside the document, so whatever
 * was visible at that moment would otherwise stay stuck visible forever (confirmed live as a
 * real, reported bug — the cursor being in a reveal zone right as it left the window). Watching
 * `document`'s own `mouseout` with `relatedTarget === null` (the standard way to distinguish
 * "left the document" from "moved to a different element still inside it") is what catches that
 * case too, arming the same hide timer as leaving the zone normally would.
 *
 * `isInZone` is read via a ref rather than as an effect dependency deliberately — the caller
 * almost never memoizes an inline arrow function like this, and a real bug confirmed live
 * elsewhere in this app (useNumericChannelEntry) showed exactly what goes wrong otherwise: a
 * dependency that changes identity on every render tears down and rebuilds the listeners (and
 * cancels any pending hide timer) on every render, not just when something meaningful changed.
 *
 * Returns `[visible, setVisible]`, the second so a caller can also trigger visibility from
 * outside hovering entirely (e.g. "show on load" when a new title starts playing).
 *
 * `enabled` isn't just a filter — it's also this hook's only way to notice the container
 * actually exists yet, since the setup effect reads `containerRef.current` once per dependency
 * change, not via a callback ref. A caller whose `enabled` never changes (e.g. a hardcoded
 * `true`) is a real, confirmed trap if the surrounding component can render *before* the
 * container exists and then never re-run this effect afterward — exactly what happens in a
 * component that returns `null` until some condition is met and never truly unmounts in between
 * (Player.tsx's own instance persists across an entire close/reopen). Make sure `enabled`
 * genuinely flips from false to true no earlier than the container is guaranteed to exist —
 * Player.tsx does this with a small `playerMounted` state set from a callback ref, ANDed into
 * every call site's own `enabled` value.
 */
export function useHoverAutoHide<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  isInZone: (e: MouseEvent, rect: DOMRect) => boolean,
  autoHideMs: number,
  enabled: boolean
): [boolean, (visible: boolean) => void] {
  const [visible, setVisible] = useState(false)
  const hoveredRef = useRef(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInZoneRef = useRef(isInZone)
  isInZoneRef.current = isInZone

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    function armHideTimer(): void {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      hideTimerRef.current = setTimeout(() => setVisible(false), autoHideMs)
    }

    function onMouseMove(e: MouseEvent): void {
      const rect = container!.getBoundingClientRect()
      const inZone = isInZoneRef.current(e, rect)
      if (inZone === hoveredRef.current) return
      hoveredRef.current = inZone
      if (inZone) {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current)
          hideTimerRef.current = null
        }
        setVisible(true)
      } else {
        armHideTimer()
      }
    }

    function onDocumentMouseOut(e: MouseEvent): void {
      if (e.relatedTarget !== null || !hoveredRef.current) return
      hoveredRef.current = false
      armHideTimer()
    }

    container.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseout', onDocumentMouseOut)
    return () => {
      container.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseout', onDocumentMouseOut)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
    // containerRef is a stable ref object (from useRef); isInZone is deliberately read via
    // isInZoneRef above instead of listed here — see this function's own doc comment.
  }, [containerRef, enabled, autoHideMs])

  return [visible, setVisible]
}
