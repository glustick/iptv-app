import { useCallback, useEffect, useRef, useState } from 'react'

// How long to wait after the last digit before committing — long enough to type a real
// multi-digit channel number (e.g. "101") without each digit jumping early, short enough that
// committing doesn't feel sluggish once you've stopped typing.
const DIGIT_ENTRY_TIMEOUT_MS = 1500
// Caps how many digits accumulate — a real provider's channel numbers here run into the low
// thousands at most (a ~24k-channel test catalog's own `num` values are nowhere near 4 digits),
// so this is just a sane ceiling against a stray held-down key, not a meaningful limit in
// practice.
const MAX_DIGITS = 4

/**
 * Captures 0-9 keypresses anywhere on the page (while `enabled`) into a short-lived buffer and
 * calls `onCommit` with the accumulated number once the user pauses (or presses Enter) — the
 * "type a channel number, it jumps there" convention a real TV remote already has. Ignored
 * entirely while an actual text input/textarea/select is focused, so typing in the search box
 * (or a group-rename field, etc.) is never hijacked into a channel jump.
 *
 * Returns the current in-progress digit string for a caller to show as a brief on-screen
 * overlay (e.g. "Channel 10…") — empty when nothing is being typed.
 */
export function useNumericChannelEntry(onCommit: (num: number) => void, enabled: boolean): string {
  const [display, setDisplay] = useState('')
  const bufferRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read fresh on every call via the ref below rather than being a dependency anywhere — a
  // caller almost never memoizes this inline callback, and a real bug confirmed live: with
  // onCommit as a dependency, `commit`'s identity (and so the effect below, which depended on
  // it) changed on every keystroke's own re-render, tearing down and rebuilding the listener —
  // which cleared the very debounce timer a keystroke had just armed, so it could never actually
  // fire. Callers can pass a fresh arrow function every render and this still works correctly.
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const commit = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (bufferRef.current) onCommitRef.current(Number(bufferRef.current))
    bufferRef.current = ''
    setDisplay('')
  }, [])

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.key >= '0' && e.key <= '9') {
        bufferRef.current = (bufferRef.current + e.key).slice(-MAX_DIGITS)
        setDisplay(bufferRef.current)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(commit, DIGIT_ENTRY_TIMEOUT_MS)
      } else if (e.key === 'Enter' && bufferRef.current) {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape' && bufferRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current)
        bufferRef.current = ''
        setDisplay('')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [enabled, commit])

  return display
}
