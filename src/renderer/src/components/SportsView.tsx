import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAppStore } from '../store/useAppStore'
import { buildSportsSchedule, dayKeyOf, sportOfLeague, type SportsGame } from '../lib/sports'
import {
  DEFAULT_SPORT_ID,
  SPORT_SOURCES,
  fetchSportEventsForDate,
  sportEventFromFootballFixture,
  sportSourceById,
  type SportEvent,
  type SportEventsResult
} from '../lib/api-sports'
import {
  fetchFixturesForDate,
  fixtureDateParam,
  normalizeFixturesFromPayload,
  type FixtureFetchResult
} from '../lib/api-football'
import { channelsMentioningTeams, matchEventsToGames } from '../lib/fixtureMatch'
import {
  countryOptions,
  filterEvents,
  groupEventsByLeague,
  leagueGroupLabel,
  leagueOptions,
  leaguePairLabel
} from '../lib/sportsGroups'
import { localKickoffLabel } from '../lib/gameTimes'
import { useResizableWidth } from '../lib/useResizableWidth'
import type { Category, LiveStream } from '../lib/types'

// The Sports tab, rebuilt around the api-football.com family (2026-09-29 request): the left pane
// is the platform's OWN sport categories, exactly (SPORT_SOURCES — one API host per sport); the
// middle pane is that sport's games for the selected day, from the API itself, each showing the
// kickoff in the viewer's local time with their local system timezone in parentheses plus, when
// live, a LIVE badge and the current score; the right pane finds the channels carrying the
// selected game in the provider's own catalogue (paired by team names, with a conservative
// name-search fallback — see lib/fixtureMatch.ts) and plays them on click through the existing
// play() path, so player wiring, history and Escape handling all come for free.
//
// Since 0.14.0 the middle pane's day list is grouped into league subsections (lib/sportsGroups —
// groups follow the list's own live-first ordering, so live competitions surface first), with a
// country and a league filter above them; the filters persist across days within a sport (stepping
// days while filtered is the point) and reset when the sport changes.
//
// Football keeps its own request path and per-day cache (lib/api-football.ts — the settings
// sportsFixturesCache and the Refresh button semantics shipped in 0.10.0 are untouched); every
// other sport goes through lib/api-sports.ts and the api-sports:fetch bridge.

const DAY_RANGE = 7
// A handful of high-school/regional categories parse into thousands of games; rendering them
// all in a plain list would freeze the pane. The count is still shown so the size is honest.
const MAX_GAMES_RENDERED = 300

function formatDayLabel(dayKey: string): string {
  const [year, month, date] = dayKey.split('-').map(Number)
  const d = new Date(year, month - 1, date)
  const today = dayKeyOf(new Date())
  if (dayKey === today) return 'Today'
  const tomorrow = dayKeyOf(new Date(Date.now() + 86_400_000))
  if (dayKey === tomorrow) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

/** The viewer-local kickoff with the local system zone in parentheses — "19:45 (GMT+8)". */
function kickoffLabel(event: SportEvent, hour12: boolean): string {
  return event.kickoff ? localKickoffLabel(event.kickoff.getTime(), hour12) : 'TBD'
}

/** "2–1" when either side carries a score number; null when neither does (MMA, F1, scheduled). */
function scoreLabel(event: SportEvent): string | null {
  if (event.homeScore === null && event.awayScore === null) return null
  return `${event.homeScore ?? 0}–${event.awayScore ?? 0}`
}

/** One API game row: local kickoff + teams, with a LIVE/FT badge and score on the right. */
function GameRow({
  event,
  hour12,
  selected,
  onSelect
}: {
  event: SportEvent
  hour12: boolean
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const score = scoreLabel(event)
  const matchup = event.awayName ? `${event.homeName} vs ${event.awayName}` : event.homeName
  const title = [event.league, event.round, event.statusLong, event.country].filter(Boolean).join(' · ')
  return (
    <button
      className={selected ? 'sports-item active' : 'sports-item'}
      onClick={onSelect}
      title={title || matchup}
    >
      <span className="sports-item-label">
        {kickoffLabel(event, hour12)} · {matchup}
      </span>
      {event.live || event.finished ? (
        <span className="sports-item-right">
          <span className={event.live ? 'sports-live' : 'sports-ft'}>{event.live ? 'LIVE' : 'FT'}</span>
          {score ? <span className="sports-item-count">{score}</span> : null}
        </span>
      ) : null}
    </button>
  )
}

export function SportsView(): JSX.Element {
  const client = useAppStore((s) => s.client)
  const catalog = useAppStore((s) => s.numericChannelCatalog)
  const ensureChannelCatalog = useAppStore((s) => s.ensureChannelCatalog)
  const play = useAppStore((s) => s.play)
  const apiFootballKey = useAppStore((s) => s.settings.apiFootballKey) ?? ''
  const hour12 = useAppStore((s) => s.settings.clockFormat) === '12h'
  const updateSettings = useAppStore((s) => s.updateSettings)

  // The store's categories state belongs to the Live TV browse flow (requestCategory replaces
  // it); Sports classifies its own copy so switching tabs never disturbs that state.
  const [categories, setCategories] = useState<Category[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedSportId, setSelectedSportId] = useState<string>(DEFAULT_SPORT_ID)
  const [dayOffset, setDayOffset] = useState(0)
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null)
  // The league/country filters ('' = all). They persist across days within a sport — stepping
  // days while filtered is the point — and reset when the sport changes, since another sport's
  // competitions are different names entirely.
  const [countryFilter, setCountryFilter] = useState('')
  const [leagueFilter, setLeagueFilter] = useState('')
  // Bumped by the refresh button: forces the day's games to be requested again even where a
  // cache would otherwise answer (0.10.0's per-day cache for football; the session cache below
  // for the other sports).
  const [refreshNonce, setRefreshNonce] = useState(0)

  // Football's day (its own path + cache) and every other sport's day (the api-sports bridge).
  const [fixtureResult, setFixtureResult] = useState<FixtureFetchResult>({ fixtures: [], error: null })
  const [sportResult, setSportResult] = useState<SportEventsResult>({ events: [], error: null })
  const [sportLoading, setSportLoading] = useState(false)
  // Fixed days for the non-football sports are session-cached (never written to settings: the
  // one payload slot there belongs to football, and today deliberately refetches on its own).
  const sportDayCache = useRef(new Map<string, SportEventsResult>())

  const source = sportSourceById(selectedSportId) ?? SPORT_SOURCES[0]
  const isFootball = source.kind === 'fixtures'

  // Football fixtures for the picked day — an independent data source from the provider's
  // channel schedule below, so its failures are contained: an error renders one line and the
  // channel side stays fully usable. No key = feature unconfigured; nothing is fetched.
  //
  // Any day OTHER than today is served from settings.sportsFixturesCache when it is there: a past
  // or future day's fixtures do not change, so requesting them again on every open is pure waste
  // against the free tier's 100 requests/day. Today is deliberately never cached — its scores and
  // statuses move, and the 5-minute refetch below is what keeps them honest.
  useEffect(() => {
    if (!apiFootballKey || !isFootball) return
    let active = true
    const date = new Date(Date.now() + dayOffset * 86_400_000)
    const dayKey = fixtureDateParam(date)
    const storeCache = useAppStore.getState().settings.sportsFixturesCache
    const cached = dayOffset !== 0 && refreshNonce === 0 && storeCache?.day === dayKey ? storeCache : null
    if (cached) {
      // The raw payload, re-normalized on read — see sportsFixturesCache for why the normalized
      // form is not what gets stored.
      setFixtureResult({ fixtures: normalizeFixturesFromPayload(cached.payload), error: null })
      return
    }
    const load = (): void => {
      void fetchFixturesForDate(window.api.apiFootball.fetch, apiFootballKey, date).then((result) => {
        if (!active) return
        setFixtureResult(result)
        if (result.payload !== undefined) {
          // Taken from the store rather than the component's own binding: this effect is declared
          // above it, and a zustand action's identity is stable anyway.
          useAppStore
            .getState()
            .updateSettings({ sportsFixturesCache: { day: dayKey, fetchedAt: Date.now(), payload: result.payload } })
        }
      })
    }
    load()
    const timer = dayOffset === 0 ? setInterval(load, 300_000) : null
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [apiFootballKey, isFootball, dayOffset, refreshNonce])

  // Every other sport's day through the api-sports bridge. Same containment: one error line,
  // nothing else in the pane disturbed. Fixed days come from the session cache above; today
  // always refetches (a stale LIVE row is worse than none).
  useEffect(() => {
    if (!apiFootballKey || isFootball || !source) return
    const date = new Date(Date.now() + dayOffset * 86_400_000)
    const cacheKey = `${source.id}|${fixtureDateParam(date)}`
    const cached = dayOffset !== 0 && refreshNonce === 0 ? sportDayCache.current.get(cacheKey) : undefined
    if (cached) {
      setSportResult(cached)
      setSportLoading(false)
      return
    }
    let active = true
    setSportLoading(true)
    void fetchSportEventsForDate(window.api.apiSports.fetch, source, apiFootballKey, date).then((result) => {
      if (!active) return
      setSportLoading(false)
      setSportResult(result)
      if (!result.error) sportDayCache.current.set(cacheKey, result)
    })
    return () => {
      active = false
    }
  }, [apiFootballKey, isFootball, source, dayOffset, refreshNonce])

  useEffect(() => {
    let active = true
    void ensureChannelCatalog()
    if (client && categories.length === 0) {
      client
        .getLiveCategories()
        .then((cats) => {
          if (active) setCategories(cats)
        })
        .catch((err) => {
          if (active) setLoadError(err instanceof Error ? err.message : 'Failed to load categories')
        })
    }
    return () => {
      active = false
    }
  }, [client, categories.length, ensureChannelCatalog])

  const schedule = useMemo(
    () => (catalog && categories.length > 0 ? buildSportsSchedule(catalog, categories, new Date()) : null),
    [catalog, categories]
  )

  // The provider side of the join, scoped to the selected sport: every parsed game whose
  // competition belongs to it, and every channel inside those competitions (the name-search
  // fallback's universe). One fixture often appears across several categories; the schedule
  // already collapsed those into one game with all its feeds.
  const sportGames = useMemo(() => {
    if (!schedule) return [] as SportsGame[]
    const games: SportsGame[] = []
    for (const league of schedule.leagues) {
      if (sportOfLeague(league.id) !== selectedSportId) continue
      games.push(...(schedule.gamesByLeague[league.id] ?? []))
    }
    return games
  }, [schedule, selectedSportId])

  const sportStreams = useMemo(() => {
    if (!schedule || !catalog) return [] as LiveStream[]
    const categoryIds = new Set<string>()
    for (const league of schedule.leagues) {
      if (sportOfLeague(league.id) !== selectedSportId) continue
      for (const categoryId of league.categoryIds) categoryIds.add(categoryId)
    }
    return catalog.filter((channel) => categoryIds.has(channel.category_id))
  }, [schedule, catalog, selectedSportId])

  // The middle pane's list, one row component for every sport: football's fixtures adapted to
  // the family's shape, everything else already normalized by lib/api-sports.ts. Live first,
  // then upcoming by kickoff, then finished (most recent first); no kickoff sorts last.
  const events = useMemo(() => {
    const list: SportEvent[] = isFootball
      ? fixtureResult.fixtures.map(sportEventFromFootballFixture)
      : sportResult.events
    const rank = (event: SportEvent): number => (event.live ? 0 : event.finished ? 2 : 1)
    const time = (event: SportEvent): number => event.kickoff?.getTime() ?? Number.POSITIVE_INFINITY
    return [...list].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      if (rank(a) === 2) {
        const at = a.kickoff?.getTime() ?? 0
        const bt = b.kickoff?.getTime() ?? 0
        if (at !== bt) return bt - at
      } else if (time(a) !== time(b)) {
        return time(a) - time(b)
      }
      return a.homeName.localeCompare(b.homeName)
    })
  }, [isFootball, fixtureResult, sportResult])

  const dayKey = fixtureDateParam(new Date(Date.now() + dayOffset * 86_400_000))

  // The filters and the subsections. Options come from the day's own list (a filter can only
  // ever offer what exists), the league list narrowed by the chosen country; a selection that
  // the narrowed list no longer contains stays readable via its own label (leaguePairLabel) —
  // it just shows the honest "no games match" line until a day that has it again.
  const filteredEvents = useMemo(() => filterEvents(events, leagueFilter, countryFilter), [events, leagueFilter, countryFilter])
  const groups = useMemo(() => groupEventsByLeague(filteredEvents), [filteredEvents])
  const countries = useMemo(() => countryOptions(events), [events])
  const leagues = useMemo(() => leagueOptions(events, countryFilter), [events, countryFilter])

  function selectCountry(next: string): void {
    setCountryFilter(next)
    // A league pair encodes its country; a country switch can orphan the selection, and an
    // orphaned pair filter matches nothing by construction.
    if (leagueFilter && next && !leagueFilter.startsWith(`${next}\u001f`)) setLeagueFilter('')
  }

  function selectLeague(next: string): void {
    setLeagueFilter(next)
  }

  // Pair every listed event with at most one provider game (exact, then loose only when
  // unambiguous). Inverted to event → game; when the same pair appears on more than one parsed
  // day (a baseball series), the game whose own day matches the event's wins.
  const pairing = useMemo(() => matchEventsToGames(events, sportGames), [events, sportGames])
  const gameByEventId = useMemo(() => {
    const map = new Map<number, SportsGame>()
    for (const game of sportGames) {
      const event = pairing.byGame.get(game.key)
      if (!event) continue
      const existing = map.get(event.id)
      if (!existing) {
        map.set(event.id, game)
        continue
      }
      const wanted = event.kickoff ? dayKeyOf(event.kickoff) : null
      if (existing.dayKey !== wanted && game.dayKey === wanted) map.set(event.id, game)
    }
    return map
  }, [pairing, sportGames])

  const selectedEvent = events.find((event) => `${event.sportId}:${event.id}` === selectedEventKey) ?? null

  // The selected game's channels: the paired provider game's feeds when there is one, otherwise
  // a deliberately conservative name search across the sport's channels (it will not conjure a
  // match — see lib/fixtureMatch.ts — but it does surface the feeds that plausibly are about it).
  const selectedChannels = useMemo(() => {
    if (!selectedEvent) return null
    const game = gameByEventId.get(selectedEvent.id)
    if (game) return { channels: game.channels, viaName: false }
    return {
      channels: channelsMentioningTeams(sportStreams, selectedEvent.homeName, selectedEvent.awayName),
      viaName: true
    }
  }, [selectedEvent, gameByEventId, sportStreams])

  // All three panes are drag-resizable; left and middle persist their width, the right pane
  // flexes to fill the remainder — same mechanics as the app's sidebar and EPG panel.
  const left = useResizableWidth(useAppStore((s) => s.settings.sportsLeftWidth), 1, {
    min: 170,
    max: 520,
    onCommit: (w) => updateSettings({ sportsLeftWidth: w })
  })
  const middle = useResizableWidth(useAppStore((s) => s.settings.sportsMiddleWidth), 1, {
    min: 240,
    max: 900,
    onCommit: (w) => updateSettings({ sportsMiddleWidth: w })
  })

  function playChannel(channel: LiveStream): void {
    play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon, channel.tv_archive, channel.playlistId)
  }

  function selectSport(sportId: string): void {
    setSelectedSportId(sportId)
    setSelectedEventKey(null)
    setCountryFilter('')
    setLeagueFilter('')
    setRefreshNonce(0)
  }

  function selectDay(nextOffset: number): void {
    setDayOffset(Math.max(-DAY_RANGE, Math.min(DAY_RANGE, nextOffset)))
    setSelectedEventKey(null)
  }

  if (loadError) {
    return <div className="sports-view"><div className="sports-status">{loadError}</div></div>
  }
  if (!schedule) {
    return <div className="sports-view"><div className="sports-status">Loading sports…</div></div>
  }

  return (
    <div className="sports-view">
      <div className="sports-pane sports-sports" style={{ flex: `0 0 ${left.width}px` }}>
        <div className="resize-handle resize-handle--right" onMouseDown={left.startDrag} />
        <div className="sports-pane-title">Sports</div>
        <div className="sports-list">
          {SPORT_SOURCES.map((sport) => (
            <button
              key={sport.id}
              className={sport.id === selectedSportId ? 'sports-item active' : 'sports-item'}
              onClick={() => selectSport(sport.id)}
              title={`${sport.label} — api-sports.com (${sport.host})`}
            >
              <span className="sports-item-label">{sport.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sports-pane sports-games" style={{ flex: `0 0 ${middle.width}px` }}>
        <div className="resize-handle resize-handle--right" onMouseDown={middle.startDrag} />
        <div className="sports-pane-title">
          {source.label}
          <span className="sports-pane-sub">api-sports.com</span>
          {/* The manual refresh — a fixed day is otherwise answered from cache, and today's
              live-refetching day has no reason to wait for the next tick. */}
          <button
            className="sports-fixtures-refresh"
            onClick={() => setRefreshNonce((n) => n + 1)}
            title="Request this day's games again now, ignoring the cached copy"
          >
            ↻ Refresh
          </button>
        </div>
        <div className="sports-day-nav">
          <button onClick={() => selectDay(dayOffset - 1)} title="Earlier">◀</button>
          <span className="sports-day-label">{formatDayLabel(dayKey)}</span>
          <button onClick={() => selectDay(dayOffset + 1)} title="Later">▶</button>
        </div>
        {/* The country/league filters. Rendered only when the day has games; their options are
            the day's own values, plus the current selection when today's list doesn't carry it
            (a filter chosen on one day must stay readable on days without its league). */}
        {apiFootballKey && events.length > 0 && (
          <div className="sports-filters">
            <select value={countryFilter} onChange={(e) => selectCountry(e.target.value)} title="Show only games from one country">
              <option value="">All countries</option>
              {!countries.includes(countryFilter) && countryFilter ? <option value={countryFilter}>{countryFilter}</option> : null}
              {countries.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select value={leagueFilter} onChange={(e) => selectLeague(e.target.value)} title="Show only one competition">
              <option value="">All leagues</option>
              {!leagues.some((o) => o.key === leagueFilter) && leagueFilter ? (
                <option value={leagueFilter}>{leaguePairLabel(leagueFilter)}</option>
              ) : null}
              {leagues.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </div>
        )}
        <div className="sports-list">
          {!apiFootballKey ? (
            <div className="sports-empty">
              Add your api-football.com key in Settings → Sports data to see games here.
            </div>
          ) : isFootball ? (
            fixtureResult.error ? (
              <div className="sports-empty">{fixtureResult.error}</div>
            ) : events.length === 0 ? (
              <div className="sports-empty">No games listed for this day.</div>
            ) : null
          ) : sportResult.error ? (
            <div className="sports-empty">{sportResult.error}</div>
          ) : sportLoading && events.length === 0 ? (
            <div className="sports-empty">Loading…</div>
          ) : events.length === 0 ? (
            <div className="sports-empty">No games listed for this day.</div>
          ) : null}
          {apiFootballKey && events.length > 0 && filteredEvents.length === 0 && (
            <div className="sports-empty">No games match the current filters.</div>
          )}
          {apiFootballKey &&
            (() => {
              // The cap spans the whole pane, headers included: a league whose rows would land
              // past it contributes only what fits, and the tail line counts what didn't.
              let rendered = 0
              const nodes: JSX.Element[] = []
              for (const group of groups) {
                if (rendered >= MAX_GAMES_RENDERED) break
                const rows = group.events.slice(0, MAX_GAMES_RENDERED - rendered)
                nodes.push(
                  <div className="sports-section-label" key={group.key}>
                    <span>{group.league ? leagueGroupLabel(group.league, group.country) : 'Other'}</span>
                    {group.liveCount > 0 ? <span className="sports-live">LIVE</span> : null}
                  </div>
                )
                for (const event of rows) {
                  const rowKey = `${event.sportId}:${event.id}`
                  nodes.push(
                    <GameRow
                      key={rowKey}
                      event={event}
                      hour12={hour12}
                      selected={rowKey === selectedEventKey}
                      onSelect={() => setSelectedEventKey(rowKey === selectedEventKey ? null : rowKey)}
                    />
                  )
                }
                rendered += rows.length
              }
              if (filteredEvents.length > rendered) {
                nodes.push(
                  <div key="sports-more" className="sports-empty">…and {filteredEvents.length - rendered} more games</div>
                )
              }
              return nodes
            })()}
        </div>
      </div>

      <div className="sports-pane sports-channels">
        {selectedEvent ? (
          <>
            <div className="sports-pane-title">
              {selectedEvent.awayName ? `${selectedEvent.homeName} vs ${selectedEvent.awayName}` : selectedEvent.homeName}
              <span className="sports-pane-sub">
                {kickoffLabel(selectedEvent, hour12)}
                {selectedEvent.league ? ` · ${selectedEvent.league}` : ''}
                {selectedEvent.live ? ' · LIVE' : selectedEvent.finished ? ' · FT' : ''}
                {scoreLabel(selectedEvent) ? ` ${scoreLabel(selectedEvent)}` : ''}
              </span>
            </div>
            <div className="sports-list">
              {selectedChannels && selectedChannels.channels.length === 0 ? (
                <div className="sports-empty">No channels found for this game.</div>
              ) : null}
              {selectedChannels?.viaName && selectedChannels.channels.length > 0 ? (
                <div className="sports-empty">
                  No feed matched this game by name in the catalogue — these channels mention its teams.
                </div>
              ) : null}
              {selectedChannels?.channels.slice(0, MAX_GAMES_RENDERED).map((channel) => (
                <button
                  key={`${channel.playlistId ?? ''}:${channel.stream_id}`}
                  className="sports-item"
                  onClick={() => playChannel(channel)}
                >
                  <span className="sports-item-label">{channel.name}</span>
                  {channel.stream_icon ? (
                    <img className="sports-channel-icon" src={channel.stream_icon} alt="" loading="lazy" />
                  ) : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="sports-status">Select a game to list its channels.</div>
        )}
      </div>
    </div>
  )
}
