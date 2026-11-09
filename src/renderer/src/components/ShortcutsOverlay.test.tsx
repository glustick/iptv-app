// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ShortcutsOverlay } from './ShortcutsOverlay'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'
import { useAppStore } from '../store/useAppStore'

afterEach(() => cleanup())

describe('the keyboard cheat-sheet', () => {
  it('renders nothing until it is opened', () => {
    useAppStore.setState({ shortcutsOpen: false })
    render(<ShortcutsOverlay />)
    expect(screen.queryByLabelText('Keyboard shortcuts')).toBeNull()
  })

  it('lists every group it carries, once opened', () => {
    useAppStore.setState({ shortcutsOpen: true })
    render(<ShortcutsOverlay />)
    expect(screen.getByLabelText('Keyboard shortcuts')).toBeTruthy()
    for (const group of SHORTCUT_GROUPS) {
      expect(screen.getByText(group.title)).toBeTruthy()
    }
  })

  it('closes through the store', () => {
    useAppStore.setState({ shortcutsOpen: true })
    render(<ShortcutsOverlay />)
    fireEvent.click(screen.getByText('Close'))
    expect(useAppStore.getState().shortcutsOpen).toBe(false)
  })
})
