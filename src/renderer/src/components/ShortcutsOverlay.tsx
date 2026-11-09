import type { JSX } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'

/**
 * The keyboard cheat-sheet (0.26.0), opened with `?`.
 *
 * A modal rather than a page: it exists to answer one question and get out of the way, and Escape
 * closes it through the same chain every other overlay uses (lib/overlays.ts), so it cannot become
 * the next modal that ignores the key.
 */
export function ShortcutsOverlay(): JSX.Element | null {
  const open = useAppStore((s) => s.shortcutsOpen)
  const close = useAppStore((s) => s.closeShortcuts)
  if (!open) return null

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-card shortcuts-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <h2>Keyboard shortcuts</h2>
        <div className="shortcuts-groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={`${group.title}:${item.keys}`} className="shortcut-row">
                    <dt>{item.keys}</dt>
                    <dd>{item.action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="pin-actions">
          <button type="button" className="secondary-button" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
