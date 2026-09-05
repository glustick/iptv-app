import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Shows something instantly while the cursor is within a given zone of a container, and hides
 * it again after `autoHideMs` once the cursor leaves that zone — whether it moved elsewhere
 * within the container, left the window/document entirely, or the window simply lost focus
 * without the cursor ever visiting it again.
 *
 * Both "leave" cases share the same root problem a plain position-driven `mousemove` handler
 * can't see on its own: whatever was visible at the last real `mousemove` stays stuck visible
 * forever once no more of those events arrive, since nothing else ever re-evaluates the zone.
 * `document`'s own `mouseout` with `relatedTarget === null` (the standard way to distinguish
 * "left the document" from "moved to a different element still inside it") catches the cursor
 * physically leaving the window. `window`'s own `blur` catches a case `mouseout` can't: a
 * fullscreen player on one monitor while the cursor works in a different, unfocused window on a
 * second monitor — the cursor never crosses this window's bounds at all (no `mousemove`, no
 * `mouseout`, nothing), so without this the header would stay visible for as long as the other
 * window has focus, confirmed live as a real, reported bug on exactly that two-monitor setup.
 * Both arm the same hide timer leaving the zone normally would.
 *
 * `window`'s own `focus` is the other half of that fix, confirmed live as a real, reported
 * regression on Windows specifically: once blur hides something, Windows (unlike macOS) simply
 * doesn't deliver `mousemove` to a window that isn't focused at all, at the OS level — so hovering
 * back over the zone while the window is still unfocused does nothing at all, and nothing brings
 * it back until the cursor happens to move *again* after the window is refocused. Treating
 * regained focus the same as the "show on load" case (via the exact same reconciliation the
 * external `show` setter already does — see its own comment below) fixes that: it reappears the
 * instant the window is refocused if the cursor's last known position genuinely is in the zone,
 * and otherwise still shows briefly before fading again, matching what a user regaining focus on
 * the window would expect either way.
 *
 * `isInZone` is read via a ref rather than as an effect dependency deliberately — the caller
 * almost never memoizes an inline arrow function like this, and a real bug confirmed live
 * elsewhere in this app (useNumericChannelEntry) showed exactly what goes wrong otherwise: a
 * dependency that changes identity on every render tears down and rebuilds the listeners (and
 * cancels any pending hide timer) on every render, not just when something meaningful changed.
 *
 * Returns `[visible, show]`, the second so a caller can also trigger visibility from outside
 * hovering entirely (e.g. "show on load" when a new title starts playing). That external show
 * reconciles against the last real mousemove seen (tracked independently of any zone
 * transition) rather than just trusting `hoveredRef`'s stale value — confirmed live as a real,
 * reported bug without this: `hoveredRef` starts (and, after any earlier real hover, can settle
 * back to) `false`, so if the cursor's first `mousemove` after an external show already reads as
 * "outside the zone," it matches `hoveredRef`'s existing value and the mousemove handler's own
 * transition-only check (`if (inZone === hoveredRef.current) return`) treats that as "nothing
 * changed" rather than a leave — the exact case when the cursor simply never moves again after a
 * title loads (or is already resting elsewhere, e.g. wherever the user clicked to start playback,
 * when it loads). Using the last known mousemove event to decide up front — rather than
 * unconditionally arming a timer — is what keeps a cursor that's genuinely, if motionlessly,
 * resting in the zone at that exact moment (e.g. right after clicking a control in the header
 * itself) from being wrongly hidden a few seconds later for no reason other than not having moved
 * since.
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
  // Every real mousemove, regardless of whether it crossed a zone boundary — unlike hoveredRef,
  // which only updates on a transition — so `show` below can reconcile against where the cursor
  // actually last was, not just infer "outside" by default.
  const lastMouseEventRef = useRef<MouseEvent | null>(null)

  // Declared before the effect below (which calls it on window focus) rather than after — safe
  // regardless of source order since the effect's own callback only actually runs once React
  // commits, well after this closure has been assigned, but keeping the reference straightforward
  // to read matters here since the two are now genuinely coupled.
  const show = useCallback(
    (value: boolean) => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      setVisible(value)
      if (!value) return
      const container = containerRef.current
      const lastEvent = lastMouseEventRef.current
      const stillInZone = container && lastEvent ? isInZoneRef.current(lastEvent, container.getBoundingClientRect()) : false
      hoveredRef.current = stillInZone
      if (!stillInZone) hideTimerRef.current = setTimeout(() => setVisible(false), autoHideMs)
    },
    [autoHideMs, containerRef]
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    function armHideTimer(): void {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      hideTimerRef.current = setTimeout(() => setVisible(false), autoHideMs)
    }

    function onMouseMove(e: MouseEvent): void {
      lastMouseEventRef.current = e
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

    function onWindowBlur(): void {
      if (!hoveredRef.current) return
      hoveredRef.current = false
      armHideTimer()
    }

    function onWindowFocus(): void {
      show(true)
    }

    container.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseout', onDocumentMouseOut)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    return () => {
      container.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseout', onDocumentMouseOut)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
    // containerRef is a stable ref object (from useRef); isInZone is deliberately read via
    // isInZoneRef above instead of listed here — see this function's own doc comment. show is
    // deliberately omitted too — it only ever changes identity alongside autoHideMs/containerRef,
    // which are already listed, so it can never actually go stale here.
  }, [containerRef, enabled, autoHideMs])

  return [visible, show]
}
