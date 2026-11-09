import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAppStore } from '../store/useAppStore'
import { countByKind, searchAll, type SearchEntry, type SearchHit } from '../lib/globalSearch'

/**
 * One search for the whole app (0.24.0) — ⌘K / Ctrl-K from anywhere, or `/` when not typing.
 *
 * The catalogues are already in memory, so this is a filter, not a request. Picking a result does
 * what clicking it would have done: a channel or film plays through the store's own `play`, and a
 * series jumps to the Series tab with its name in the filter — the show's episodes are fetched by
 * the modal, which this palette has no business duplicating.
 */
export function SearchPalette(): JSX.Element | null {
  const liveStreams = useAppStore((s) => s.liveStreams)
  const vodStreams = useAppStore((s) => s.vodStreams)
  const series = useAppStore((s) => s.series)
  const play = useAppStore((s) => s.play)
  const setViewMode = useAppStore((s) => s.setViewMode)
  const setSearchTerm = useAppStore((s) => s.setSearchTerm)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

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
    return [...live, ...movies, ...shows]
  }, [liveStreams, vodStreams, series])

  const hits = useMemo(() => searchAll(entries, query), [entries, query])
  const counts = useMemo(() => countByKind(hits), [hits])

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

  const pick = (hit: SearchHit): void => {
    if (hit.kind === 'live') {
      const channel = liveStreams.find((entry) => entry.stream_id === hit.id)
      if (channel) play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon, channel.tv_archive, channel.playlistId)
    } else if (hit.kind === 'movie') {
      play('movie', hit.id, hit.name, hit.extension ?? 'mp4', hit.icon)
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
          placeholder="Search channels, films and series…"
          aria-label="Search channels, films and series"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (hits.length === 0) return
              event.preventDefault()
              const delta = event.key === 'ArrowDown' ? 1 : -1
              setHighlight((current) => Math.min(hits.length - 1, Math.max(0, current + delta)))
              return
            }
            if (event.key === 'Enter' && hits[highlight]) {
              event.preventDefault()
              pick(hits[highlight])
            }
            if (event.key === 'Escape') setOpen(false)
          }}
        />
        <div className="search-palette-meta">
          {query.trim().length < 2
            ? 'Type at least two characters'
            : `${counts.live} live · ${counts.movie} films · ${counts.series} series`}
        </div>
        <ul className="search-palette-results" role="listbox" aria-label="Search results">
          {query.trim().length >= 2 && hits.length === 0 && <li className="search-palette-empty">No matches</li>}
          {hits.map((hit, index) => (
            <li key={`${hit.kind}:${hit.id}`} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                className={index === highlight ? 'search-palette-hit active' : 'search-palette-hit'}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pick(hit)}
              >
                <span className={`search-palette-kind search-palette-kind--${hit.kind}`}>
                  {hit.kind === 'live' ? 'LIVE' : hit.kind === 'movie' ? 'FILM' : 'SERIES'}
                </span>
                <span className="search-palette-name">{hit.name}</span>
                {hit.note && <span className="search-palette-note">{hit.note}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="search-palette-foot">↑↓ to move · Enter to play · Esc to close</div>
      </div>
    </div>
  )
}
