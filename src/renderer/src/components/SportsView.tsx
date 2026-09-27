import { useEffect, useMemo, useState, type JSX } from 'react'
import { useAppStore } from '../store/useAppStore'
import { buildSportsSchedule, dayKeyOf, gamesForDay, type SportsGame, type SportsGroup } from '../lib/sports'
import {
  fetchFixturesForDate,
  type ApiFootballFixture,
  type FixtureFetchResult
} from '../lib/api-football'
import {
  dualTimeLabel,
  formatDualFromInstant,
  formatDualFromWall,
  venueTimezoneForCountry
} from '../lib/gameTimes'
import { useResizableWidth } from '../lib/useResizableWidth'
import type { Category, LiveStream } from '../lib/types'

// The Sports tab: sporting categories (Football / Soccer pinned first) → games for a selected
// day → the channels carrying that game → the existing full player. All data comes from the
// one bulk catalog fetch (ensureChannelCatalog) filtered through the pure lib/sports.ts —
// no extra provider requests, and the channel click reuses the exact play() path the rest of
// the app uses, so player wiring, history and Escape handling come for free.

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

/**
 * Kickoff times show BOTH sides: the venue's wall clock and the viewer's local one
 * ("15:00 ET · 03:00 +1d"). When both read the same numbers only one is shown — a repeated
 * identical time is noise, not information.
 */
function formatKickoff(game: SportsGame, hour12: boolean): string {
  if (!game.kickoff) return 'Time TBD'
  if (game.venueTime) {
    return dualTimeLabel(
      formatDualFromWall(
        game.venueTime.hour,
        game.venueTime.minute,
        game.venueTime.tzLabel,
        game.kickoff.getTime(),
        hour12
      )
    )
  }
  // Date-only names default to a midday placeholder — no real wall time to dual-display.
  return game.kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** One api-football fixture row: score when there is one, dual kickoff time before it starts. */
function FixtureRow({ fixture, hour12 }: { fixture: ApiFootballFixture; hour12: boolean }): JSX.Element {
  const right = fixture.live ? 'LIVE' : fixture.finished ? 'FT' : null
  const time = fixture.kickoff
    ? dualTimeLabel(formatDualFromInstant(fixture.kickoff.getTime(), venueTimezoneForCountry(fixture.country), hour12))
    : 'TBD'
  return (
    <div
      className="sports-item"
      title={`${fixture.league} — ${fixture.round} (${fixture.statusLong}) · ${fixture.country}`}
    >
      <span className="sports-item-label">
        {right === null ? `${time} · ` : ''}
        {fixture.homeTeam} {fixture.homeGoals ?? '–'}–{fixture.awayGoals ?? '–'} {fixture.awayTeam}
      </span>
      <span className="sports-item-count">{right ?? '·'}</span>
    </div>
  )
}

export function SportsView(): JSX.Element {
  const client = useAppStore((s) => s.client)
  const catalog = useAppStore((s) => s.numericChannelCatalog)
  const ensureChannelCatalog = useAppStore((s) => s.ensureChannelCatalog)
  const play = useAppStore((s) => s.play)
  const apiFootballKey = useAppStore((s) => s.settings.apiFootballKey) ?? ''

  // The store's categories state belongs to the Live TV browse flow (requestCategory replaces
  // it); Sports classifies its own copy so switching tabs never disturbs that state.
  const [categories, setCategories] = useState<Category[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedLeagueId, setSelectedLeagueId] = useState<string | null>(null)
  const [dayOffset, setDayOffset] = useState(0)
  const [selectedGameKey, setSelectedGameKey] = useState<string | null>(null)
  const [fixtureResult, setFixtureResult] = useState<FixtureFetchResult>({ fixtures: [], error: null })

  // api-football fixtures for the picked day — an independent data source from the provider's
  // channel schedule below, so its failures are contained: an error renders one line and the
  // schedule stays fully usable. No key = feature unconfigured; nothing is fetched and nothing
  // extra renders. The 5-minute refetch keeps live scores honest without burning the free-tier
  // request quota (100/day on api-football's free plan).
  useEffect(() => {
    if (!apiFootballKey) return
    let active = true
    const load = (): void => {
      void fetchFixturesForDate(
        window.api.apiFootball.fetch,
        apiFootballKey,
        new Date(Date.now() + dayOffset * 86_400_000)
      ).then((result) => {
        if (active) setFixtureResult(result)
      })
    }
    load()
    const timer = setInterval(load, 300_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [apiFootballKey, dayOffset])

  // Live matches first, then by kickoff — the two questions a sports viewer asks ("what's on
  // right now", "what's coming up") in one ordering.
  const orderedFixtures = useMemo(() => {
    return [...fixtureResult.fixtures].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1
      const at = a.kickoff?.getTime() ?? Number.POSITIVE_INFINITY
      const bt = b.kickoff?.getTime() ?? Number.POSITIVE_INFINITY
      return at - bt
    })
  }, [fixtureResult.fixtures])

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

  const selectedLeague = schedule?.leagues.find((l) => l.id === selectedLeagueId) ?? null
  const games = selectedLeague ? (schedule?.gamesByLeague[selectedLeague.id] ?? []) : []
  const dayKey = dayKeyOf(new Date(Date.now() + dayOffset * 86_400_000))
  const dayGames = gamesForDay(games, dayKey)
  const unscheduled = games.filter((g) => g.dayKey === null)
  const selectedGame = games.find((g) => g.key === selectedGameKey) ?? null
  // Channels of the selected league that carry no event name (plain broadcast feeds of that
  // competition) — the right pane's fallback listing when no game is selected.
  const carrierChannels = useMemo(() => {
    if (!selectedLeague || !catalog) return []
    const ids = new Set(selectedLeague.categoryIds)
    return catalog
      .filter((c) => ids.has(c.category_id))
      .filter((c) => !games.some((g) => g.channels.some((ch) => ch.stream_id === c.stream_id && ch.playlistId === c.playlistId)))
      .sort((a, b) => a.num - b.num)
  }, [selectedLeague, catalog, games])

  const hour12 = useAppStore((s) => s.settings.clockFormat) === '12h'
  const updateSettings = useAppStore((s) => s.updateSettings)
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

  if (loadError) {
    return <div className="sports-view"><div className="sports-status">{loadError}</div></div>
  }
  if (!schedule) {
    return <div className="sports-view"><div className="sports-status">Loading sports…</div></div>
  }
  if (schedule.leagues.length === 0 && schedule.channels.length === 0) {
    return <div className="sports-view"><div className="sports-status">No sports categories on this provider.</div></div>
  }

  return (
    <div className="sports-view">
      <div className="sports-pane sports-sports" style={{ flex: `0 0 ${left.width}px` }}>
        <div className="resize-handle resize-handle--right" onMouseDown={left.startDrag} />
        <div className="sports-pane-title">Leagues</div>
        <div className="sports-list">
          {schedule.leagues.map((league: SportsGroup) => (
            <button
              key={league.id}
              className={league.id === selectedLeagueId ? 'sports-item active' : 'sports-item'}
              onClick={() => {
                setSelectedLeagueId(league.id)
                setSelectedGameKey(null)
              }}
              title={`${league.label} — ${league.country}`}
            >
              <span className="sports-item-label">{league.isFootball ? '⚽ ' : ''}{league.label}</span>
              <span className="sports-item-count">{league.channelCount}</span>
            </button>
          ))}
          {schedule.channels.length > 0 && (
            <>
              <div className="sports-section-label">Channels</div>
              {schedule.channels.slice(0, MAX_GAMES_RENDERED).map((channel) => (
                <button
                  key={`${channel.playlistId ?? ''}:${channel.stream_id}`}
                  className="sports-item"
                  onClick={() => playChannel(channel)}
                >
                  <span className="sports-item-label">{channel.name}</span>
                  {channel.stream_icon ? <img className="sports-channel-icon" src={channel.stream_icon} alt="" loading="lazy" /> : null}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="sports-pane sports-games" style={{ flex: `0 0 ${middle.width}px` }}>
        <div className="resize-handle resize-handle--right" onMouseDown={middle.startDrag} />
        {apiFootballKey ? (
          <>
            <div className="sports-section-label">Fixtures · api-football.com</div>
            <div className="sports-list sports-fixtures">
              {fixtureResult.error ? (
                <div className="sports-empty">{fixtureResult.error}</div>
              ) : orderedFixtures.length === 0 ? (
                <div className="sports-empty">No fixtures listed for this day.</div>
              ) : (
                orderedFixtures.slice(0, MAX_GAMES_RENDERED).map((fixture) => (
                  <FixtureRow key={fixture.id} fixture={fixture} hour12={hour12} />
                ))
              )}
            </div>
          </>
        ) : null}
        {selectedLeague ? (
          <>
            <div className="sports-pane-title">{selectedLeague.label}</div>
            <div className="sports-day-nav">
              <button onClick={() => setDayOffset((o) => Math.max(-DAY_RANGE, o - 1))} title="Earlier">◀</button>
              <span className="sports-day-label">{formatDayLabel(dayKey)}</span>
              <button onClick={() => setDayOffset((o) => Math.min(DAY_RANGE, o + 1))} title="Later">▶</button>
            </div>
            <div className="sports-list">
              {dayGames.length === 0 && <div className="sports-empty">No games scheduled this day.</div>}
              {dayGames.slice(0, MAX_GAMES_RENDERED).map((game) => (
                <button
                  key={game.key}
                  className={game.key === selectedGameKey ? 'sports-item active' : 'sports-item'}
                  onClick={() => setSelectedGameKey(game.key === selectedGameKey ? null : game.key)}
                  title={`${game.channels.length} channel${game.channels.length === 1 ? '' : 's'} carry this game`}
                >
                  <span className="sports-item-label">
                    {formatKickoff(game, hour12)} · {game.homeDisplay} vs {game.awayDisplay}
                  </span>
                  <span className="sports-item-count">{game.channels.length} feed{game.channels.length === 1 ? '' : 's'}</span>
                </button>
              ))}
              {dayGames.length > MAX_GAMES_RENDERED && (
                <div className="sports-empty">…and {dayGames.length - MAX_GAMES_RENDERED} more games</div>
              )}
              {unscheduled.length > 0 && (
                <>
                  <div className="sports-section-label">Unscheduled</div>
                  {unscheduled.slice(0, MAX_GAMES_RENDERED).map((game) => (
                    <button
                      key={game.key}
                      className={game.key === selectedGameKey ? 'sports-item active' : 'sports-item'}
                      onClick={() => setSelectedGameKey(game.key === selectedGameKey ? null : game.key)}
                    >
                      <span className="sports-item-label">
                        {game.homeDisplay} vs {game.awayDisplay}
                      </span>
                      <span className="sports-item-count">{game.channels.length} feed{game.channels.length === 1 ? '' : 's'}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </>
        ) : (
          <div className="sports-status">Pick a sport to see its games.</div>
        )}
      </div>

      <div className="sports-pane sports-channels">
        {selectedGame ? (
          <>
            <div className="sports-pane-title">
              {selectedGame.homeDisplay} vs {selectedGame.awayDisplay}
              <span className="sports-pane-sub">{formatKickoff(selectedGame, hour12)}</span>
            </div>
            <div className="sports-list">
              {selectedGame.channels.map((channel) => (
                <button key={`${channel.playlistId ?? ''}:${channel.stream_id}`} className="sports-item" onClick={() => playChannel(channel)}>
                  <span className="sports-item-label">{channel.name}</span>
                  {channel.stream_icon ? <img className="sports-channel-icon" src={channel.stream_icon} alt="" loading="lazy" /> : null}
                </button>
              ))}
            </div>
          </>
        ) : selectedLeague ? (
          <>
            <div className="sports-pane-title">All {selectedLeague.label} channels</div>
            <div className="sports-list">
              {carrierChannels.length === 0 && <div className="sports-empty">Select a game to list its channels.</div>}
              {carrierChannels.slice(0, MAX_GAMES_RENDERED).map((channel) => (
                <button key={`${channel.playlistId ?? ''}:${channel.stream_id}`} className="sports-item" onClick={() => playChannel(channel)}>
                  <span className="sports-item-label">{channel.name}</span>
                  {channel.stream_icon ? <img className="sports-channel-icon" src={channel.stream_icon} alt="" loading="lazy" /> : null}
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
