import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'

interface Options {
  min: number
  max: number
  onCommit?: (width: number) => void
}

/**
 * Drag-to-resize a panel's width from one of its edges.
 * `direction: 1` for a handle on the panel's right edge (dragging right grows it),
 * `direction: -1` for a handle on its left edge (dragging left grows it).
 */
export function useResizableWidth(
  initialWidth: number,
  direction: 1 | -1,
  { min, max, onCommit }: Options
): { width: number; startDrag: (e: ReactMouseEvent) => void } {
  const [width, setWidth] = useState(initialWidth)
  const widthRef = useRef(initialWidth)

  const startDrag = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = widthRef.current

      function onMouseMove(ev: globalThis.MouseEvent): void {
        const delta = (ev.clientX - startX) * direction
        const next = Math.min(max, Math.max(min, startWidth + delta))
        widthRef.current = next
        setWidth(next)
      }
      function onMouseUp(): void {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        document.body.classList.remove('resizing-col')
        onCommit?.(widthRef.current)
      }
      document.body.classList.add('resizing-col')
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [direction, min, max, onCommit]
  )

  return { width, startDrag }
}
