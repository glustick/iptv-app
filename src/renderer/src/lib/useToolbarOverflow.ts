import { useCallback, useRef, useState } from 'react'

// Once already compact, only reverts if there's this much slack — without it, hiding labels
// (which shrinks scrollWidth) could immediately read as "fits now," re-showing labels, which
// immediately overflows again, flipping back and forth every layout pass. A genuine resize or
// button-set change large enough to clear this margin is a real, stable "there's room now"
// signal rather than the compact toggle's own side effect.
const REVERT_MARGIN_PX = 150

/**
 * Tracks whether an element's own content is wider than the space actually available to it
 * (scrollWidth > clientWidth) — for a responsive toolbar that should drop to icon-only once it
 * genuinely can't fit every button's full label, without needing to enumerate every piece of
 * state that could add/remove a button. A ResizeObserver catches the container itself resizing
 * (e.g. the window narrowing); a MutationObserver catches buttons being added/removed even when
 * the container's own box size doesn't change (it's already clipping overflow). Toggling the
 * returned boolean is expected to only affect descendants' *visibility* (e.g. `display: none` on
 * a label), not add/remove DOM nodes or resize the observed element itself — doing so only
 * through a CSS class keyed off this value, applied to an ancestor rather than the observed
 * element's own subtree, is what keeps that resulting layout pass from re-triggering either
 * observer and causing a feedback loop.
 *
 * Returns a callback ref, not a ref object — deliberately. A plain `useRef` + a mount-time
 * `useEffect([])` looked correct but was a real, confirmed bug: the caller here (Player.tsx)
 * never actually unmounts across a close/reopen (it just returns `null` before anything is
 * playing), so its very first render — before any content plays, DOM node not created yet —
 * already ran that effect once with `ref.current` still null, and an empty dependency array
 * meant it could never run again once the node genuinely appeared. A callback ref instead fires
 * exactly when React actually attaches (or detaches) this specific node, independent of whatever
 * the surrounding component's own mount lifecycle looks like.
 */
export function useToolbarOverflow<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [compact, setCompact] = useState(false)
  const observersRef = useRef<{ resize: ResizeObserver; mutation: MutationObserver } | null>(null)

  const setRef = useCallback((node: T | null) => {
    if (observersRef.current) {
      observersRef.current.resize.disconnect()
      observersRef.current.mutation.disconnect()
      observersRef.current = null
    }
    if (!node) return

    // node is non-null here (see the guard above) — TypeScript just can't carry that narrowing
    // into a nested function closure over a parameter, hence the assertions.
    function check(): void {
      setCompact((prevCompact) =>
        prevCompact ? !(node!.clientWidth - node!.scrollWidth > REVERT_MARGIN_PX) : node!.scrollWidth > node!.clientWidth
      )
    }

    const resizeObserver = new ResizeObserver(check)
    resizeObserver.observe(node)
    const mutationObserver = new MutationObserver(check)
    mutationObserver.observe(node, { childList: true, subtree: true, characterData: true })
    observersRef.current = { resize: resizeObserver, mutation: mutationObserver }
    check()
  }, [])

  return [setRef, compact]
}
