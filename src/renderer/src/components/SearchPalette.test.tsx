// @vitest-environment jsdom
//
// The palette is a modal over the store: it opens on a keystroke, filters what is already loaded,
// and calls the store's own actions on Enter. Those three wirings are exactly what a component test
// can hold still — no packaging, no provider — so this file exists rather than leaving the feature
// to the GUI smoke alone (which cannot run here).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SearchPalette } from './SearchPalette'
import { useAppStore } from '../store/useAppStore'
import type { EpgData, EpgProgramme } from '../lib/epg'
import type { LiveStream, VodStream } from '../lib/types'

afterEach(() => cleanup())

const PALETTE_LABEL = 'Search channels, films, series and the guide'

function live(id: number, name: string, epgChannelId: string | null = null): LiveStream {
  return {
    num: id, name, stream_type: 'live', stream_id: id, stream_icon: '', epg_channel_id: epgChannelId,
    added: '', category_id: '1', custom_sid: null, tv_archive: 0, direct_source: ''
  } as LiveStream
}

function film(id: number, name: string): VodStream {
  return {
    num: id, name, stream_type: 'movie', stream_id: id, stream_icon: '', rating: '7.1',
    rating_5based: 3.5, added: '', category_id: '10', container_extension: 'mkv', direct_source: ''
  } as VodStream
}

// One on-now programme on a guide channel the fixture's channel resolves to by EPG id.
function guideWithNowProgramme(title: string): EpgData {
  const now = Date.now()
  const programme: EpgProgramme = {
    channelId: 'one.hd',
    title,
    start: new Date(now - 30 * 60_000),
    stop: new Date(now + 30 * 60_000)
  }
  return {
    channels: new Map([['one.hd', { id: 'one.hd', displayName: 'One HD' }]]),
    programmesByChannel: new Map([['one.hd', [programme]]])
  }
}

describe('the search palette', () => {
  it('opens on Ctrl-K, filters what is loaded, and plays the chosen channel', async () => {
    const play = vi.fn()
    useAppStore.setState({ liveStreams: [live(1, 'Fixture News One')], vodStreams: [], series: [], play } as never)
    render(<SearchPalette />)

    expect(screen.queryByLabelText(PALETTE_LABEL)).toBeNull()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })

    const input = await screen.findByLabelText(PALETTE_LABEL)
    fireEvent.change(input, { target: { value: 'fixture' } })
    await screen.findByText('Fixture News One')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(play).toHaveBeenCalledWith('live', 1, 'Fixture News One', 'm3u8', '', 0, undefined)
  })

  it('plays a film with the catalogue’s own extension', async () => {
    const play = vi.fn()
    useAppStore.setState({ liveStreams: [], vodStreams: [film(7, 'Fixture Film')], series: [], play } as never)
    render(<SearchPalette />)
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = await screen.findByLabelText(PALETTE_LABEL)
    fireEvent.change(input, { target: { value: 'fixture film' } })
    await screen.findByText('Fixture Film')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(play).toHaveBeenCalledWith('movie', 7, 'Fixture Film', 'mkv', '')
  })

  it('offers commands alongside the catalogue, and they switch tab', async () => {
    const setViewMode = vi.fn(async () => {})
    useAppStore.setState({ liveStreams: [live(1, 'Movies Night')], vodStreams: [], series: [], setViewMode } as never)
    render(<SearchPalette />)
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = await screen.findByLabelText(PALETTE_LABEL)
    fireEvent.change(input, { target: { value: 'go to movies' } })

    // A command is scored like any other entry, so it wins here by starting with the query — the
    // channel called "Movies Night" is still listed below it.
    const options = await screen.findAllByRole('option')
    expect(options[0].textContent).toContain('Go to Movies')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(setViewMode).toHaveBeenCalledWith('movies'))
  })

  it('finds a guide programme and Enter plays its channel when it is on now', async () => {
    const play = vi.fn()
    useAppStore.setState({
      liveStreams: [live(1, 'One HD', 'one.hd')],
      vodStreams: [],
      series: [],
      epgSources: [guideWithNowProgramme("One's Show")],
      epgSourceLabels: ['provider guide'],
      primaryPlaylistId: null,
      play
    } as never)
    render(<SearchPalette />)
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = await screen.findByLabelText(PALETTE_LABEL)
    fireEvent.change(input, { target: { value: 'show' } })

    // The programme hit names its channel and says it is on now.
    const hit = await screen.findByText("One's Show")
    expect(hit.closest('button')?.textContent).toContain('One HD')
    expect(hit.closest('button')?.textContent).toContain('On now')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(play).toHaveBeenCalledWith('live', 1, 'One HD', 'm3u8', '', 0, undefined)
  })

  it('closes on Escape', async () => {
    useAppStore.setState({ liveStreams: [], vodStreams: [], series: [] } as never)
    render(<SearchPalette />)
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    await screen.findByLabelText(PALETTE_LABEL)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText(PALETTE_LABEL)).toBeNull())
  })
})
