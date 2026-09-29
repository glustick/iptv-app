// The api-football.com family — the sports data APIs behind the same account.
//
// api-football.com (the site the Sports tab's football fixtures already come from) is the front
// door to API-Sports' per-sport APIs: each sport lives on its own host, all answering the one
// account key. The Sports tab's left pane is built from THIS list — the platform's own sport
// categories, matched exactly — because the schedules it shows for each of them come from these
// feeds (the request: categories are to align with the API's, exactly, since the schedules are
// sourced from it).
//
// What has been observed live against the real account (2026-09-29, this machine):
//  - all twelve hosts answer `status` with the account's own key;
//  - day queries return real fixtures for football (v3 `/fixtures`), and `/games?date=` for
//    basketball, baseball, hockey, handball, volleyball (the shapes below were taken from those
//    live responses, not assumed);
//  - rugby answers the same `/games` shape family (the web sibling ships it after the same check);
//  - AFL's `/games` and MMA's `/fights` shapes are taken from API-Sports' own documentation
//    (AFL: `game.id` nesting + `scores.home.score`; MMA: `fighters.first/second`), because no
//    event fell inside the free plan's ±1-day window on the day this was written;
//  - NBA's `/games` shape is from API-Sports' documentation too (v2.nba: `teams.visitors/home`,
//    `scores.*.points`, `date.start`) — its season had not started, so no live sample existed;
//  - Formula-1 races are season-scoped (`/races?season=`) and the current free plan only opens
//    the 2022–2024 seasons to it — the plan's own message is surfaced verbatim when that bites.
//
// The free plan limits every day-query to today ±1; out-of-range days answer with an in-band
// `errors.plan` message, which this module passes through unchanged (the pane shows it as-is).
//
// Pure module: no window/document/Electron imports (docs/STATE.md), unit-tested directly.

import { fixtureDateParam, type ApiFootballFixture } from './api-football'

/** One sport "category" — the platform's own list, exact names, football first then alphabetical. */
export interface SportSource {
  /** Stable slug, also the key the main process pins its host against. */
  id: string
  /** Display name exactly as api-football.com presents the product ("Formula-1", "NBA", "MMA"). */
  label: string
  /** The sport's own API host. */
  host: string
  /** Day-query endpoint family: football's is /fixtures, most others /games, MMA /fights, F1 /races. */
  kind: 'fixtures' | 'games' | 'fights' | 'races'
}

/**
 * The platform's sport categories, in the order api-football.com presents them (football first,
 * the rest alphabetical). This list is the single source of truth for the left pane AND for the
 * main process's host allowlist — adding or removing a sport is one entry here plus one there.
 */
export const SPORT_SOURCES: SportSource[] = [
  { id: 'football', label: 'Football', host: 'v3.football.api-sports.io', kind: 'fixtures' },
  { id: 'afl', label: 'AFL', host: 'v1.afl.api-sports.io', kind: 'games' },
  { id: 'baseball', label: 'Baseball', host: 'v1.baseball.api-sports.io', kind: 'games' },
  { id: 'basketball', label: 'Basketball', host: 'v1.basketball.api-sports.io', kind: 'games' },
  { id: 'formula-1', label: 'Formula-1', host: 'v1.formula-1.api-sports.io', kind: 'races' },
  { id: 'handball', label: 'Handball', host: 'v1.handball.api-sports.io', kind: 'games' },
  { id: 'hockey', label: 'Hockey', host: 'v1.hockey.api-sports.io', kind: 'games' },
  { id: 'mma', label: 'MMA', host: 'v1.mma.api-sports.io', kind: 'fights' },
  { id: 'nba', label: 'NBA', host: 'v2.nba.api-sports.io', kind: 'games' },
  { id: 'nfl', label: 'NFL', host: 'v1.american-football.api-sports.io', kind: 'games' },
  { id: 'rugby', label: 'Rugby', host: 'v1.rugby.api-sports.io', kind: 'games' },
  { id: 'volleyball', label: 'Volleyball', host: 'v1.volleyball.api-sports.io', kind: 'games' }
]

export function sportSourceById(id: string): SportSource | null {
  return SPORT_SOURCES.find((source) => source.id === id) ?? null
}

/** The default category: football, first in the platform's own order. */
export const DEFAULT_SPORT_ID = 'football'

/** One normalized event row — what the games pane renders, whichever sport it came from. */
export interface SportEvent {
  id: number
  sportId: string
  kickoff: Date | null
  league: string
  country: string
  round: string
  homeName: string
  awayName: string
  homeScore: number | null
  awayScore: number | null
  live: boolean
  finished: boolean
  statusShort: string
  statusLong: string
}

export interface SportEventsResult {
  events: SportEvent[]
  // Null when the fetch succeeded or was skipped by design (no key). Non-null never blocks the
  // rest of the pane — the provider schedule stays usable underneath.
  error: string | null
}

// In-play / terminal short-status codes, unioned across the platform's sports. These feeds are all
// the same engine, so the codes don't collide across sports; a union here means one normalizer can
// serve basketball's "Q1" (observed live), hockey's "P1", volleyball's "S2" (observed live),
// handball's halves, the football codes, and MMA's rounds. A code outside both sets (NS, TBD, PST,
// CANC, ABD, SUSP, AWD, WO …) is deliberately "neither" — scheduled/postponed rows must not badge.
const LIVE_SHORT_STATUSES = new Set([
  '1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT', // football (established)
  'Q1', 'Q2', 'Q3', 'Q4', 'OT', // basketball / american football
  'P1', 'P2', 'P3', // hockey
  'S1', 'S2', 'S3', 'S4', 'S5', // volleyball
  'H1', 'H2', // handball
  'R1', 'R2', 'R3', 'R4', 'R5' // MMA rounds (not yet observed live; harmless if unused)
])
const FINISHED_SHORT_STATUSES = new Set(['FT', 'AET', 'PEN', 'AOT', 'AP', 'AFT'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Number form of a score that the platform's shapes put in three different places. */
function scoreNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const record = asRecord(value)
  if (!record) return null
  // Order matters: AFL carries {score, goals, behinds} and the total is `score`; basketball/NBA
  // nest {total}/{points}; american football nests per-quarter detail around a `total`.
  for (const key of ['total', 'score', 'points']) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return null
}

function parseDateValue(value: unknown): Date | null {
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms) : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  return null
}

/** The kickoff instant from whichever date nesting a shape uses. */
function kickoffOf(raw: Record<string, unknown>, kind: SportSource['kind']): Date | null {
  if (kind === 'games') {
    const game = asRecord(raw.game)
    // american-football: game.date = {timestamp (s), date, time}; AFL nests a plain ISO
    // `date`; others: a plain ISO `date` at the top level.
    if (game) {
      const nested = asRecord(game.date)
      if (nested) {
        if (typeof nested.timestamp === 'number' && Number.isFinite(nested.timestamp)) {
          return new Date(nested.timestamp * 1000)
        }
        const fromDate = parseDateValue(nested.date)
        if (fromDate) return fromDate
      }
      const gameDate = parseDateValue(game.date)
      if (gameDate) return gameDate
    }
    // NBA v2: date = {start, end, duration}.
    const dateField = asRecord(raw.date)
    if (dateField) {
      const start = parseDateValue(dateField.start)
      if (start) return start
    }
  }
  const direct = parseDateValue(raw.date)
  if (direct) return direct
  if (typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)) {
    return new Date(raw.timestamp * 1000)
  }
  return null
}

/** One `/games` entry — the shape basketball, baseball, hockey, rugby, handball, volleyball, AFL,
 * american-football and NBA all use, with the documented per-sport variations folded in. */
function normalizeGameEntry(raw: Record<string, unknown>, source: SportSource): SportEvent | null {
  const game = asRecord(raw.game) ?? {}
  const status = asRecord(raw.status) ?? asRecord(game.status) ?? {}
  const short = stringOf(status.short)
  const long = stringOf(status.long)
  const teams = asRecord(raw.teams) ?? {}
  const homeTeam = asRecord(teams.home)
  // NBA v2 names the sides visitors/home instead of away/home.
  const awayTeam = asRecord(teams.away) ?? asRecord(teams.visitors)
  const scores = asRecord(raw.scores) ?? {}
  const id = typeof game.id === 'number' ? game.id : typeof raw.id === 'number' ? raw.id : 0
  const homeName = stringOf(homeTeam?.name)
  const awayName = stringOf(awayTeam?.name)
  if (!homeName && !awayName) return null

  // NBA's v2 status uses period numbers ("1".."4") with a `halftime` flag and a long text that
  // says "Finished"; every other shape uses the platform's usual short codes.
  const finishedByText = source.id === 'nba' && /finished/i.test(long)
  const finished = finishedByText || FINISHED_SHORT_STATUSES.has(short)
  const live =
    !finished &&
    (LIVE_SHORT_STATUSES.has(short) ||
      (source.id === 'nba' && (status.halftime === true || /^[1-9]$/.test(short))))

  const league = asRecord(raw.league)
  const country = asRecord(raw.country)
  const leagueCountry = asRecord(league?.country)
  return {
    id,
    sportId: source.id,
    kickoff: kickoffOf(raw, source.kind),
    league: stringOf(league?.name) || stringOf(raw.league),
    country: stringOf(country?.name) || stringOf(leagueCountry?.name),
    round: stringOf(raw.round),
    homeName,
    awayName,
    homeScore: scoreNumber(scores.home),
    // NBA v2 keys its sides visitors/home, so the away score rides under `visitors` there.
    awayScore: scoreNumber(scores.away) ?? scoreNumber(scores.visitors),
    live,
    finished,
    statusShort: short,
    statusLong: long
  }
}

/** One `/fights` entry (MMA): fighters.first/second instead of teams, no numeric score. */
function normalizeFightEntry(raw: Record<string, unknown>, source: SportSource): SportEvent | null {
  const status = asRecord(raw.status) ?? {}
  const short = stringOf(status.short)
  const fighters = asRecord(raw.fighters) ?? {}
  const first = asRecord(fighters.first)
  const second = asRecord(fighters.second)
  const homeName = stringOf(first?.name)
  const awayName = stringOf(second?.name)
  if (!homeName && !awayName) return null
  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    sportId: source.id,
    kickoff: kickoffOf(raw, source.kind),
    // The event name (slug) is the useful grouping ("UFC Fight Night: …"); the weight category
    // rides in `round` so the row's tooltip can say what the bout is.
    league: stringOf(raw.slug),
    country: '',
    round: stringOf(raw.category),
    homeName,
    awayName,
    homeScore: null,
    awayScore: null,
    live: LIVE_SHORT_STATUSES.has(short),
    finished: FINISHED_SHORT_STATUSES.has(short),
    statusShort: short,
    statusLong: stringOf(status.long)
  }
}

/** One `/races` entry (Formula-1): a race is the "event"; there is no second side or score. */
function normalizeRaceEntry(raw: Record<string, unknown>, source: SportSource): SportEvent | null {
  const competition = asRecord(raw.competition)
  const location = asRecord(competition?.location)
  const status = stringOf(raw.status)
  const name = stringOf(competition?.name)
  if (!name) return null
  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    sportId: source.id,
    kickoff: parseDateValue(raw.date),
    league: name,
    country: stringOf(location?.country),
    round: stringOf(raw.type), // "Race", "Sprint", …
    homeName: name,
    awayName: '',
    homeScore: null,
    awayScore: null,
    live: /^live$/i.test(status),
    finished: /completed|finished/i.test(status),
    statusShort: status,
    statusLong: status
  }
}

/** In-band error, following the platform's envelope: 200 with an `errors` object/array/string. */
function describeInBandError(errors: unknown): string | null {
  if (errors == null) return null
  if (Array.isArray(errors)) {
    const parts = errors.map((v) => String(v).trim()).filter((v) => v.length > 0)
    return parts.length > 0 ? parts.join('; ') : null
  }
  if (typeof errors === 'object') {
    const parts = Object.values(errors as Record<string, unknown>)
      .filter((v) => v != null)
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0)
    return parts.length > 0 ? parts.join('; ') : null
  }
  const text = String(errors).trim()
  return text.length > 0 ? text : null
}

/** The relative request path for one source's day query. Races are season-scoped (see module head). */
export function sportPathFor(source: SportSource, date: Date): string {
  if (source.kind === 'races') {
    return `/races?season=${date.getFullYear()}`
  }
  const day = fixtureDateParam(date)
  return `/${source.kind}?date=${day}`
}

/**
 * Normalizes a raw response for one source into event rows. Pure: the same payload always yields
 * the same list. Football is deliberately NOT handled here — the desktop's football path
 * (lib/api-football.ts + its own request cache) stays exactly as it is; see the view.
 */
export function normalizeSportEvents(source: SportSource, payload: unknown): SportEvent[] {
  // Football's own shape and path live in lib/api-football.ts — never normalized here.
  if (source.kind === 'fixtures') return []
  const root = asRecord(payload)
  const list = Array.isArray(root?.response) ? (root?.response as unknown[]) : []
  const events: SportEvent[] = []
  for (const item of list) {
    const raw = asRecord(item)
    if (!raw) continue
    const event =
      source.kind === 'fights'
        ? normalizeFightEntry(raw, source)
        : source.kind === 'races'
          ? normalizeRaceEntry(raw, source)
          : normalizeGameEntry(raw, source)
    if (event && event.id > 0) events.push(event)
  }
  return events
}

/**
 * The existing football fixtures' shape (lib/api-football.ts) as the family's unified event row,
 * so the games pane renders one row component for every sport. The football request path and its
 * per-day cache are deliberately untouched (see the module head).
 */
export function sportEventFromFootballFixture(fixture: ApiFootballFixture): SportEvent {
  return {
    id: fixture.id,
    sportId: 'football',
    kickoff: fixture.kickoff,
    league: fixture.league,
    country: fixture.country,
    round: fixture.round,
    homeName: fixture.homeTeam,
    awayName: fixture.awayTeam,
    homeScore: fixture.homeGoals,
    awayScore: fixture.awayGoals,
    live: fixture.live,
    finished: fixture.finished,
    statusShort: '',
    statusLong: fixture.statusLong
  }
}

/** Bridge signature for the sibling hosts — main pins and validates the host per sport id. */
export type SportFetchBridge = (sportId: string, path: string, key: string) => Promise<unknown>

/**
 * Fetch one sport's day. `key` empty means the feature is unconfigured: returns an empty list
 * with no error. Football is excluded here on purpose (the view routes it through the existing
 * api-football.ts path, so its per-day cache and refresh semantics stay untouched).
 */
export async function fetchSportEventsForDate(
  bridge: SportFetchBridge,
  source: SportSource,
  key: string,
  date: Date
): Promise<SportEventsResult> {
  if (!key || source.kind === 'fixtures') return { events: [], error: null }
  try {
    const payload = (await bridge(source.id, sportPathFor(source, date), key)) as {
      response?: unknown
      errors?: unknown
    }
    const inBand = describeInBandError(payload?.errors)
    if (inBand) return { events: [], error: `${source.label}: ${inBand}` }
    let events = normalizeSportEvents(source, payload)
    if (source.kind === 'races') {
      // The season response holds every race; a day view shows only the ones on the selected day
      // (races carry their own instants, so filter on the viewer-local calendar day, same rule the
      // day list itself uses — see dayKeyOf).
      const wanted = fixtureDateParam(date)
      events = events.filter((event) => event.kickoff && localDayKey(event.kickoff) === wanted)
    }
    return { events, error: null }
  } catch (err) {
    // Electron wraps any IPC handler throw as "Error invoking remote method 'x': Error: …" —
    // strip that plumbing so the user sees the actual failure ("API-Sports request failed (403)").
    const raw = err instanceof Error ? err.message : String(err)
    return {
      events: [],
      error: raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    }
  }
}

function localDayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
