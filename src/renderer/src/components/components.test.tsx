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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UpdatePrompt } from './UpdatePrompt'
import { Sidebar } from './Sidebar'
import { CustomCategoriesModal } from './CustomCategoriesModal'
import { GuideSettingsPage } from './GuideSettingsPage'
import { useAppStore, PROVIDER_GUIDE_LABEL } from '../store/useAppStore'
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
    guideOpen: false,
    settings: DEFAULT_SETTINGS,
    numericChannelCatalog: null,
    vodCatalog: null,
    seriesCatalog: null,
    viewMode: 'live',
    status: 'idle',
    epgSources: [],
    epgSourceLabels: [],
    epgSourceIssues: {},
    epgSourceMatchStats: [],
    providerGuideAvailable: null
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

describe('Sidebar My Categories rows', () => {
  function withCategory(): void {
    useAppStore.setState({
      viewMode: 'live',
      settings: {
        ...DEFAULT_SETTINGS,
        customCategories: [{ id: 'a', name: 'Mine', kind: 'live', streamIds: [1, 2] }]
      }
    })
  }

  it('deletes a category from the sidebar, after confirmation', () => {
    withCategory()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Sidebar />)

    fireEvent.click(screen.getByLabelText('Delete Mine'))

    expect(confirmSpy).toHaveBeenCalled()
    expect(useAppStore.getState().settings.customCategories).toEqual([])
    confirmSpy.mockRestore()
  })

  it('keeps the category when the confirmation is declined', () => {
    withCategory()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Sidebar />)

    fireEvent.click(screen.getByLabelText('Delete Mine'))

    expect(useAppStore.getState().settings.customCategories).toHaveLength(1)
    confirmSpy.mockRestore()
  })

  it('renames inline — the pencil opens an input and Enter commits', () => {
    withCategory()
    render(<Sidebar />)

    fireEvent.click(screen.getByLabelText('Rename Mine'))
    const input = screen.getByLabelText('New name for Mine')
    fireEvent.change(input, { target: { value: 'Favourites' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useAppStore.getState().settings.customCategories[0].name).toBe('Favourites')
    // …and the row is back to its button form.
    expect(screen.queryByLabelText('New name for Mine')).toBeNull()
  })

  it('backs out of a rename on Escape without renaming', () => {
    withCategory()
    render(<Sidebar />)

    fireEvent.click(screen.getByLabelText('Rename Mine'))
    const input = screen.getByLabelText('New name for Mine')
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(useAppStore.getState().settings.customCategories[0].name).toBe('Mine')
  })

  it('shows only the categories of the current tab\'s kind', () => {
    useAppStore.setState({
      viewMode: 'movies',
      settings: {
        ...DEFAULT_SETTINGS,
        customCategories: [
          { id: 'l', name: 'Live One', kind: 'live', streamIds: [] },
          { id: 'm', name: 'Movie One', kind: 'movie', streamIds: [] }
        ]
      }
    })
    render(<Sidebar />)

    expect(screen.getByText('Movie One')).toBeTruthy()
    expect(screen.queryByText('Live One')).toBeNull()
  })
})

describe('GuideSettingsPage', () => {
  const SOURCE = 'https://example.com/guide.xml'

  function withEpg(): void {
    useAppStore.setState({
      guideOpen: true,
      status: 'ready',
      providerGuideAvailable: false,
      epgSourcesStatus: 'ready',
      epgSourceLabels: [SOURCE],
      // No parsed guide object needed for these assertions — the card's status chip falls back to
      // "Not loaded" when there is none, which is exactly the state a failed/never-fetched source
      // is in.
      epgSources: [],
      epgSourceIssues: {},
      epgSourceMatchStats: [
        {
          source: PROVIDER_GUIDE_LABEL,
          available: false,
          reason: 'blocked or disabled by this provider',
          loadedChannels: 10,
          matched: 0,
          byId: 0,
          byName: 0,
          byFuzzy: 0,
          byManual: 0,
          unmatchedNames: []
        },
        {
          source: SOURCE,
          available: true,
          reason: null,
          loadedChannels: 10,
          matched: 8,
          byId: 6,
          byName: 1,
          byFuzzy: 1,
          byManual: 0,
          unmatchedNames: ['Five HD']
        }
      ],
      settings: { ...DEFAULT_SETTINGS, customEpgUrls: [SOURCE], epgChannelMappings: [] }
    })
  }

  it('renders nothing while closed', () => {
    useAppStore.setState({ guideOpen: false })
    const { container } = render(<GuideSettingsPage />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the provider guide and each custom source with its own match summary', () => {
    withEpg()
    render(<GuideSettingsPage />)

    // The provider's own guide is a first-class card, not only a row in a separate report.
    expect(screen.getByText(PROVIDER_GUIDE_LABEL)).toBeTruthy()
    expect(screen.getByText('Blocked or disabled by this provider')).toBeTruthy()
    expect(screen.getByText(SOURCE)).toBeTruthy()
    // …and the custom source carries its own matched count and tiers.
    expect(screen.getByText(/Matched 8 of 10 loaded channels/)).toBeTruthy()
    expect(screen.getByText(/1 by relaxed match/)).toBeTruthy()
    // The unmatched residue is available but tucked away behind the disclosure.
    expect(screen.getByText('2 unmatched channels')).toBeTruthy()
  })

  it('adds a source through the store', () => {
    withEpg()
    render(<GuideSettingsPage />)

    fireEvent.change(screen.getByPlaceholderText('https://example.com/epg.xml'), {
      target: { value: 'https://another.test/e.xml' }
    })
    fireEvent.click(screen.getByText('Add source'))

    expect(useAppStore.getState().settings.customEpgUrls).toContain('https://another.test/e.xml')
  })

  it('removes a source through the store', () => {
    withEpg()
    render(<GuideSettingsPage />)

    fireEvent.click(screen.getByText('Remove'))

    expect(useAppStore.getState().settings.customEpgUrls).toEqual([])
  })

  it('reprioritises sources with the arrow buttons', () => {
    withEpg()
    useAppStore.setState({
      epgSourceMatchStats: [],
      settings: { ...DEFAULT_SETTINGS, customEpgUrls: ['a.xml', 'b.xml'] }
    })
    render(<GuideSettingsPage />)

    fireEvent.click(screen.getByLabelText('Move b.xml up in priority'))

    expect(useAppStore.getState().settings.customEpgUrls).toEqual(['b.xml', 'a.xml'])
  })
})
