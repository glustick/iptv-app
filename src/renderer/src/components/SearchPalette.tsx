import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAppStore } from '../store/useAppStore'
import { countByKind, searchAll, type SearchEntry, type SearchHit } from '../lib/globalSearch'
import {
  buildGuideSearchIndex,
  searchGuideProgrammes,
  type GuideProgrammeHit
} from '../lib/guideSearch'
import type { ClockFormat } from '../lib/types'

/**
 * One search for the whole app (0.24.0) — ⌘K / Ctrl-K from anywhere, or `/` when not typing.
 *
 * The catalogues are already in memory, so this is a filter, not a request. Picking a result does
 * what clicking it would have done: a channel or film plays through the store's own `play`, and a
 * series jumps to the Series tab with its name in the filter — the show's episodes are fetched by
 * the modal, and this palette has no business duplicating that.
 *
 * Since 0.27.0 the guide is searched too: programmes on now or upcoming across every loaded guide
 * source, joined back to the channels this app can play (lib/guideSearch). Programme hits sit
 * BELOW the catalogue's own results deliberately — the catalogue's ranking rule (0.24.0) is
 * unchanged, and a channel named "News" should not be buried under thirty programmes with "News"
 * in the title. Enter on an on-air programme plays its channel; on an upcoming one it toggles the
 * same reminder the grid's bell sets.
 */

/** What the results list renders and navigates: a catalogue hit or a guide-programme hit. */
type PaletteHit =
  | (SearchHit & { kind: SearchHit['kind'] })
  | (GuideProgrammeHit & { kind: 'programme' })

function programmeNote(hit: GuideProgrammeHit, clockFormat: ClockFormat): string {
  const time = new Date(hit.startMs).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: clockFormat === '12h'
  })
  return hit.onAir ? `${hit.stream.name} · On now` : `${hit.stream.name} · ${time}`
}

export function SearchPalette(): JSX.Element | null {
  const liveStreams = useAppStore((s) => s.liveStreams)
  const vodStreams = useAppStore((s) => s.vodStreams)
  const series = useAppStore((s) => s.series)
  const play = useAppStore((s) => s.play)
  const setViewMode = useAppStore((s) => s.setViewMode)
  const setSearchTerm = useAppStore((s) => s.setSearchTerm)
  const epgSources = useAppStore((s) => s.epgSources)
  const epgSourceLabels = useAppStore((s) => s.epgSourceLabels)
  const hiddenEpgSourceUrls = useAppStore((s) => s.settings.hiddenEpgSourceUrls)
  const epgChannelMappings = useAppStore((s) => s.settings.epgChannelMappings)
  const clockFormat = useAppStore((s) => s.settings.clockFormat)
  const primaryPlaylistId = useAppStore((s) => s.primaryPlaylistId)
  const toggleEpgReminder = useAppStore((s) => s.toggleEpgReminder)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Commands are part of the same list, so one keystroke reaches both "where is that channel" and
  // "take me to the films" (0.25.0).
  const commands = useMemo<SearchEntry[]>(
    () => [
      { kind: 'command', id: 1, name: 'Go to Live TV', note: 'Tab' },
      { kind: 'command', id: 2, name: 'Go to Movies', note: 'Tab' },
      { kind: 'command', id: 3, name: 'Go to Series', note: 'Tab' },
      { kind: 'command', id: 4, name: 'Go to Sports', note: 'Tab' },
      { kind: 'command', id: 5, name: 'Go to Multi-view', note: 'Tab' }
    ],
    []
  )

  const entries = useMemo<SearchEntry[]>(() => {
    const live: SearchEntry[] = liveStreams.map((channel) => ({
      kind: 'live',
      id: channel.stream_id,
      name: channel.name,
      note: 'Live TV',
      icon: channel.stream_icon
    }))
    const movies: SearchEntry[] = vodStreams.map((movie) => ({
      kind: 'movie',
      id: movie.stream_id,
      name: movie.name,
      note: movie.rating ? `Film · ★ ${movie.rating}` : 'Film',
      extension: movie.container_extension || 'mp4',
      icon: movie.stream_icon
    }))
    const shows: SearchEntry[] = series.map((show) => ({
      kind: 'series',
      id: show.series_id,
      name: show.name,
      note: 'Series'
    }))
    return [...commands, ...live, ...movies, ...shows]
  }, [commands, liveStreams, vodStreams, series])

  // Built once per guide/catalogue change, never per keystroke — see lib/guideSearch for why that
  // bound matters against a real 178MB guide. The query below only scans this flat list.
  const guideIndex = useMemo(
    () =>
      buildGuideSearchIndex({
        liveStreams,
        epgSources,
        epgSourceLabels,
        hiddenSourceUrls: hiddenEpgSourceUrls,
        manualMappings: epgChannelMappings,
        primaryPlaylistId
      }),
    [liveStreams, epgSources, epgSourceLabels, hiddenEpgSourceUrls, epgChannelMappings, primaryPlaylistId]
  )

  const hits = useMemo(() => searchAll(entries, query), [entries, query])
  const programmeHits = useMemo(
    () => searchGuideProgrammes(guideIndex, query).map((hit) => ({ ...hit, kind: 'programme' as const })),
    [guideIndex, query]
  )
  const counts = useMemo(() => countByKind(hits), [hits])
  const results = useMemo<PaletteHit[]>(() => [...hits, ...programmeHits], [hits, programmeHits])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
        return
      }
      if (event.key === '/' && !typing && !open) {
        event.preventDefault()
        setOpen(true)
        return
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // React's autoFocus does not fire for dynamically-mounted elements (the lesson from 0.5.0).
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    setHighlight(0)
  }, [query])

  if (!open) return null

  const pick = (hit: PaletteHit): void => {
    if (hit.kind === 'command') {
      const modes = ['live', 'movies', 'series', 'sports', 'multiview'] as const
      void setViewMode(modes[hit.id - 1] ?? 'live')
    } else if (hit.kind === 'live') {
      const channel = liveStreams.find((entry) => entry.stream_id === hit.id)
      if (channel) play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon, channel.tv_archive, channel.playlistId)
    } else if (hit.kind === 'movie') {
      play('movie', hit.id, hit.name, hit.extension ?? 'mp4', hit.icon)
    } else if (hit.kind === 'programme') {
      if (hit.onAir) {
        play('live', hit.stream.stream_id, hit.stream.name, 'm3u8', hit.stream.stream_icon, hit.stream.tv_archive, hit.stream.playlistId)
      } else {
        toggleEpgReminder(hit.stream.stream_id, hit.stream.name, hit.program, hit.stream.playlistId)
      }
    } else {
      void setViewMode('series')
      setSearchTerm(hit.name)
    }
    setOpen(false)
  }

  return (
    <div className="search-palette-overlay" onClick={() => setOpen(false)}>
      <div className="search-palette" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Search everything">
        <input
          ref={inputRef}
          className="search-palette-input"
          type="text"
          value={query}
          placeholder="Search channels, films, series and the guide…"
          aria-label="Search channels, films, series and the guide"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (results.length === 0) return
              event.preventDefault()
              const delta = event.key === 'ArrowDown' ? 1 : -1
              setHighlight((current) => Math.min(results.length - 1, Math.max(0, current + delta)))
              return
            }
            if (event.key === 'Enter' && results[highlight]) {
              event.preventDefault()
              pick(results[highlight])
            }
            if (event.key === 'Escape') setOpen(false)
          }}
        />
        <div className="search-palette-meta">
          {query.trim().length < 2
            ? 'Type at least two characters'
            : `${counts.live} live · ${counts.movie} films · ${counts.series} series · ${programmeHits.length} programmes`}
        </div>
        <ul className="search-palette-results" role="listbox" aria-label="Search results">
          {query.trim().length >= 2 && results.length === 0 && <li className="search-palette-empty">No matches</li>}
          {results.map((hit, index) => (
            <li key={hit.kind === 'programme' ? `programme:${hit.stream.stream_id}:${hit.program.id}` : `${hit.kind}:${hit.id}`} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                className={index === highlight ? 'search-palette-hit active' : 'search-palette-hit'}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pick(hit)}
              >
                <span className={`search-palette-kind search-palette-kind--${hit.kind}`}>
                  {hit.kind === 'live' ? 'LIVE' : hit.kind === 'movie' ? 'FILM' : hit.kind === 'series' ? 'SERIES' : hit.kind === 'programme' ? 'GUIDE' : 'GO'}
                </span>
                <span className="search-palette-name">{hit.kind === 'programme' ? hit.program.title : hit.name}</span>
                {hit.kind === 'programme' ? (
                  <span className="search-palette-note">{programmeNote(hit, clockFormat)}</span>
                ) : (
                  hit.note && <span className="search-palette-note">{hit.note}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="search-palette-foot">↑↓ to move · Enter to play · Esc to close</div>
      </div>
    </div>
  )
}
