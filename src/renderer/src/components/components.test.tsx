// @vitest-environment jsdom
//
// The first component-rendering tests in this project. They exist because two real bugs (the
// update prompt and the My Categories manager being invisible to Escape) were invisible to the
// logic-only suite — not because the logic was wrong, but because nobody rendered these overlays.
// Scope is deliberately narrow: assert the wiring a human would otherwise have to click through —
// what renders, and that the controls reach the store. Drag-and-drop is not exercised (jsdom has
// no real drag), which is what the ⬆⬇ buttons are for in the UI as well.
//
// Note for anyone extending this: this project's vitest runs on the oxc/rolldown flavour of Vite,
// where a JSX runtime has to be enabled explicitly (`oxc: { jsx: 'automatic' }` in
// vitest.config.mts). Without it, rendering any component here fails at transform time — the
// renderer's own JSX is compiled by electron-vite, not by this config.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UpdatePrompt } from './UpdatePrompt'
import { CustomCategoriesModal } from './CustomCategoriesModal'
import { useAppStore } from '../store/useAppStore'
import { DEFAULT_SETTINGS } from '../lib/types'
import type { LiveStream } from '../lib/types'

function stream(streamId: number, name: string): LiveStream {
  return {
    num: streamId,
    name,
    stream_type: 'live',
    stream_id: streamId,
    stream_icon: '',
    epg_channel_id: null,
    added: '',
    category_id: '1',
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

beforeEach(() => {
  useAppStore.setState({
    updateInfo: null,
    updateDismissed: false,
    updateDownloaded: false,
    updateDownloadPercent: null,
    updateError: null,
    customCategoriesOpen: false,
    settings: DEFAULT_SETTINGS,
    numericChannelCatalog: null,
    vodCatalog: null,
    seriesCatalog: null,
    viewMode: 'live'
  })
})

afterEach(() => {
  cleanup()
})

describe('UpdatePrompt', () => {
  it('shows the release notes, formatted, alongside the version', () => {
    useAppStore.setState({
      updateInfo: { version: '9.9.9', releaseNotes: "What's new\n\n**Big** thing\n- one\n- two" }
    })
    render(<UpdatePrompt />)

    expect(screen.getByText(/9\.9\.9/)).toBeTruthy()
    const notes = screen.getByText(/Big thing/)
    expect(notes.textContent).toContain('• one')
    expect(notes.textContent).toContain('• two')
    // The markdown markers are gone — the prompt renders plain text.
    expect(notes.textContent).not.toContain('**')
  })

  it('renders nothing when dismissed, and no notes block when there are none', () => {
    useAppStore.setState({ updateInfo: { version: '9.9.9', releaseNotes: null } })
    render(<UpdatePrompt />)
    expect(screen.queryByText(/Big thing/)).toBeNull()
    expect(screen.getByText(/9\.9\.9/)).toBeTruthy()

    cleanup()
    useAppStore.setState({ updateInfo: { version: '9.9.9', releaseNotes: null }, updateDismissed: true })
    render(<UpdatePrompt />)
    expect(screen.queryByText(/9\.9\.9/)).toBeNull()
  })
})

describe('CustomCategoriesModal', () => {
  it('lists the current kind and switches kinds with the tabs', () => {
    useAppStore.setState({
      customCategoriesOpen: true,
      numericChannelCatalog: [stream(1, 'News HD')],
      viewMode: 'live',
      settings: {
        ...DEFAULT_SETTINGS,
        customCategories: [
          { id: 'l1', name: 'My News', kind: 'live', streamIds: [1] },
          { id: 'm1', name: 'My Movies', kind: 'movie', streamIds: [] }
        ]
      }
    })
    render(<CustomCategoriesModal />)

    // Live tab (the view mode we came from): the live category and its channel.
    expect(screen.getByText('My News')).toBeTruthy()
    expect(screen.queryByText('My Movies')).toBeNull()
    expect(screen.getAllByText(/News HD/).length).toBeGreaterThan(0)

    // Switching to the Movies tab shows the movie grouping instead.
    fireEvent.click(screen.getByText('Movies'))
    expect(screen.getByText('My Movies')).toBeTruthy()
    expect(screen.queryByText('My News')).toBeNull()
  })

  it('reorders a category with the arrow button, persisting through the store', () => {
    useAppStore.setState({
      customCategoriesOpen: true,
      viewMode: 'live',
      settings: {
        ...DEFAULT_SETTINGS,
        customCategories: [
          { id: 'a', name: 'First', kind: 'live', streamIds: [] },
          { id: 'b', name: 'Second', kind: 'live', streamIds: [] }
        ]
      }
    })
    render(<CustomCategoriesModal />)

    fireEvent.click(screen.getByLabelText('Move Second up'))

    expect(useAppStore.getState().settings.customCategories.map((c) => c.name)).toEqual(['Second', 'First'])
  })

  it('removes a channel from the selected category', () => {
    useAppStore.setState({
      customCategoriesOpen: true,
      numericChannelCatalog: [stream(7, 'Only Channel')],
      viewMode: 'live',
      settings: { ...DEFAULT_SETTINGS, customCategories: [{ id: 'c1', name: 'Mine', kind: 'live', streamIds: [7] }] }
    })
    render(<CustomCategoriesModal />)

    fireEvent.click(screen.getByLabelText('Remove Only Channel from this category'))

    expect(useAppStore.getState().settings.customCategories[0].streamIds).toEqual([])
  })
})
