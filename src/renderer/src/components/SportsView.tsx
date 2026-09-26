import { useEffect, useMemo, useState, type JSX } from 'react'
import { useAppStore } from '../store/useAppStore'
import { buildSportsSchedule, dayKeyOf, gamesForDay, type SportsGame, type SportsGroup } from '../lib/sports'
import type { Category, LiveStream } from '../lib/types'

// The Sports tab: sporting categories (Football / Soccer pinned first) → games for a selected
// day → the channels carrying that game → the existing full player. All data comes from the
// one bulk catalog fetch (ensureChannelCatalog) filtered through the pure lib/sports.ts —
// no extra provider requests, and the channel click reuses the exact play() path the rest of
// the app uses, so player wiring, history and escape handling come for free.

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

function formatKickoff(game: SportsGame): string {
  if (!game.kickoff) return 'Time TBD'
  return game.kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function SportsView(): JSX.Element {
  const client = useAppStore((s) => s.client)
  const catalog = useAppStore((s) => s.numericChannelCatalog)
  const ensureChannelCatalog = useAppStore((s) => s.ensureChannelCatalog)
  const play = useAppStore((s) => s.play)

  // The store's categories state belongs to the Live TV browse flow (requestCategory replaces
  // it); Sports classifies its own copy so switching tabs never disturbs that state.
  const [categories, setCategories] = useState<Category[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedSportId, setSelectedSportId] = useState<string | null>(null)
  const [dayOffset, setDayOffset] = useState(0)
  const [selectedGameKey, setSelectedGameKey] = useState<string | null>(null)

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

  const selectedSport = schedule?.sports.find((s) => s.id === selectedSportId) ?? null
  const games = selectedSport ? (schedule?.gamesBySport[selectedSport.id] ?? []) : []
  const dayKey = dayKeyOf(new Date(Date.now() + dayOffset * 86_400_000))
  const dayGames = gamesForDay(games, dayKey)
  const unscheduled = games.filter((g) => g.dayKey === null)
  const selectedGame = games.find((g) => g.key === selectedGameKey) ?? null
  // Channels of the selected sport that carry no event name (Sky Sports Main Event UHD etc.)
  // — reachable here so the drill-down never hides the plain broadcast channels.
  const carrierChannels = useMemo(() => {
    if (!selectedSport || !catalog) return []
    const ids = new Set(selectedSport.categoryIds)
    return catalog
      .filter((c) => ids.has(c.category_id))
      .filter((c) => !games.some((g) => g.channels.some((ch) => ch.stream_id === c.stream_id && ch.playlistId === c.playlistId)))
      .sort((a, b) => a.num - b.num)
  }, [selectedSport, catalog, games])

  function playChannel(channel: LiveStream): void {
    play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon, channel.tv_archive, channel.playlistId)
  }

  if (loadError) {
    return <div className="sports-view"><div className="sports-status">{loadError}</div></div>
  }
  if (!schedule) {
    return <div className="sports-view"><div className="sports-status">Loading sports…</div></div>
  }
  if (schedule.sports.length === 0) {
    return <div className="sports-view"><div className="sports-status">No sports categories on this provider.</div></div>
  }

  return (
    <div className="sports-view">
      <div className="sports-pane sports-sports">
        <div className="sports-pane-title">Sports</div>
        <div className="sports-list">
          {schedule.sports.map((sport: SportsGroup) => (
            <button
              key={sport.id}
              className={sport.id === selectedSportId ? 'sports-item active' : 'sports-item'}
              onClick={() => {
                setSelectedSportId(sport.id)
                setSelectedGameKey(null)
              }}
            >
              <span className="sports-item-label">{sport.isFootball ? '⚽ ' : ''}{sport.label}</span>
              <span className="sports-item-count">{sport.channelCount}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sports-pane sports-games">
        {selectedSport ? (
          <>
            <div className="sports-pane-title">{selectedSport.label}</div>
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
                >
                  <span className="sports-item-label">
                    {formatKickoff(game)} · {game.homeDisplay} vs {game.awayDisplay}
                  </span>
                  <span className="sports-item-count">{game.channels.length}</span>
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
                      <span className="sports-item-count">{game.channels.length}</span>
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
              <span className="sports-pane-sub">{formatKickoff(selectedGame)}</span>
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
        ) : selectedSport ? (
          <>
            <div className="sports-pane-title">All {selectedSport.label} channels</div>
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
