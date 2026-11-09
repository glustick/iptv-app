/**
 * The keyboard cheat-sheet (0.26.0), as data.
 *
 * Deliberately a **curated** list rather than one generated from the handlers: the bindings live in
 * four different components (App's Escape chain, the player, the grid, the channel list) with no
 * shared registry, so generating this would mean refactoring all of them for the sake of a help
 * panel. The trade is honest and recorded — a new binding has to be added here by hand, and this
 * comment is the reminder. Every entry below was read out of the handler that implements it, not
 * guessed.
 */
export interface ShortcutItem {
  keys: string
  action: string
}

export interface ShortcutGroup {
  title: string
  items: ShortcutItem[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Anywhere',
    items: [
      { keys: '⌘K / Ctrl-K', action: 'Search channels, films and series, or jump to a tab' },
      { keys: '/', action: 'Open the same search (when not typing in a field)' },
      { keys: '?', action: 'This list' },
      { keys: 'Esc', action: 'Close the topmost overlay — a dialog, then the channel bar, then the player' }
    ]
  },
  {
    title: 'Player',
    items: [
      { keys: 'M', action: 'Mute or unmute' },
      { keys: '↑ / ↓', action: 'Volume up or down' },
      { keys: '← / →', action: 'Skip back or forward (hold Shift for a longer step)' },
      { keys: 'End', action: 'Jump back to live (live TV only)' },
      { keys: 'Space', action: 'Play or pause (live TV only)' }
    ]
  },
  {
    title: 'Guide and lists',
    items: [
      { keys: '↑ / ↓', action: 'Move between channels' },
      { keys: '← / →', action: 'Move along the grid, or between tiles' },
      { keys: 'PageUp / PageDown', action: 'Move a page at a time' },
      { keys: 'Enter', action: 'Open or play what is focused' },
      { keys: 'Shift-F10 / Menu', action: 'The same as right-clicking a channel' }
    ]
  }
]
