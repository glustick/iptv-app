import type { Category, LiveStream } from './types'
import { shortZoneName, zonedWallToUtc } from './gameTimes'

/**
 * Pure sports-schedule logic behind the Sports tab — no window/document/Electron imports, per
 * docs/STATE.md, so it stays unit-testable and shareable with the web sibling.
 *
 * The provider's sports events live in CHANNEL NAMES ("Soccer01: Brentford vs Chelsea ( Sky
 * Sports Main Event Feed ) @ 3:00 pm", "EPL 05ⓧ: Newcastle United vs. Hull City AFC | Saturday,
 * 19 September 2026 15:00"), not in EPG — get_short_epg returns empty on this provider family
 * (confirmed live; see the web sibling's ROADMAP), so names are the only dependable source.
 * One real fixture often appears under several categories (EPL / EPL Backup / Soccer01 / TOD EN
 * each carry their own feed of the same match), which is exactly the shape the Sports drill-down
 * wants: one game, many channels.
 */

export interface SportsGroup {
  /** Stable slug for state/keys. */
  id: string
  /** League display name, api-football style ("Premier League", "NFL"). */
  label: string
  /** Where the competition is played ("England", "USA") — the api-football grouping axis. */
  country: string
  /** True for football competitions — always sorted to the top of the league list. */
  isFootball: boolean
  categoryIds: string[]
  channelCount: number
  /** Zone this league's feed quotes bare kickoff wall times in; null = already viewer-local. */
  venueTz: string | null
}/** The kickoff wall time exactly as written in the channel name, with its tz suffix if any. */
export interface VenueTime {
  hour: number
  minute: number
  /** Abbreviation as parsed ("ET", "BST", "GMT+3") — null when the name carried none. */
  tzLabel: string | null
}

export interface ParsedEvent {
  homeDisplay: string
  awayDisplay: string
  /** Normalized match keys — equal keys mean the same team regardless of formatting. */
  homeKey: string
  awayKey: string
  /** Local-time kickoff when the name carries a usable date/time; null → "Unscheduled". */
  kickoff: Date | null
  /** The same kickoff as the venue-side wall clock — kept for the dual-time display. */
  venueTime: VenueTime | null
}

export interface SportsGame {
  key: string
  leagueId: string
  /** The normalized team pair, sorted — the same form lib/fixtureMatch.ts compares API events
   *  against, so one game in the provider's catalogue can be found from the API's spelling too. */
  pairKey: string
  homeDisplay: string
  awayDisplay: string
  /** Local calendar day (YYYY-MM-DD) the kickoff lands on, or null when unscheduled. */
  dayKey: string | null
  kickoff: Date | null
  venueTime: VenueTime | null
  channels: LiveStream[]
}

export interface SportsSchedule {
  leagues: SportsGroup[]
  /** league id → every parsed game for that league (all days; the view filters by day). */
  gamesByLeague: Record<string, SportsGame[]>
  /** Plain carrier channels (Sky Sports Main Event etc.) across every carrier category — the
   *  left pane's flat channel list; clicking one plays it directly. */
  channels: LiveStream[]
}

// --- Category classification -----------------------------------------------------------------

interface LeagueRule {
  id: string
  label: string
  country: string
  isFootball: boolean
  venueTz: string | null
  keywords: string[]
}

// The Sports tab groups games the way api-football does — by COMPETITION (league), not by the
// provider's channel-packaging categories. Order matters: the first matching rule wins, so
// specific competitions precede the generic terms that would otherwise swallow them ("premier
// league" before the football catch-all; the football catch-all before "nfl football").
// venueTz is the zone that competition's feed quotes bare wall times in (see parseEventName).
const LEAGUE_RULES: LeagueRule[] = [
  { id: 'premier-league', label: 'Premier League', country: 'England', isFootball: true, venueTz: 'Europe/London', keywords: ['epl', 'premier league', 'barclays'] },
  { id: 'champions-league', label: 'Champions League', country: 'World', isFootball: true, venueTz: 'Europe/London', keywords: ['champions league', 'uefa champions'] },
  { id: 'europa-league', label: 'Europa League', country: 'World', isFootball: true, venueTz: 'Europe/London', keywords: ['europa league', 'europa'] },
  { id: 'conference-league', label: 'Conference League', country: 'World', isFootball: true, venueTz: 'Europe/London', keywords: ['conf. league', 'conference league'] },
  { id: 'la-liga', label: 'La Liga', country: 'Spain', isFootball: true, venueTz: 'Europe/London', keywords: ['laliga', 'la liga'] },
  { id: 'serie-a', label: 'Serie A', country: 'Italy', isFootball: true, venueTz: 'Europe/London', keywords: ['serie a'] },
  { id: 'bundesliga', label: 'Bundesliga', country: 'Germany', isFootball: true, venueTz: 'Europe/London', keywords: ['bundesliga'] },
  { id: 'ligue-1', label: 'Ligue 1', country: 'France', isFootball: true, venueTz: 'Europe/London', keywords: ['ligue 1', 'ligue-1'] },
  { id: 'championship', label: 'Championship', country: 'England', isFootball: true, venueTz: 'Europe/London', keywords: ['championship'] },
  { id: 'efl-leagues', label: 'EFL & National League', country: 'England', isFootball: true, venueTz: 'Europe/London', keywords: ['league 1', 'league 2', 'league-1', 'league-2', 'national-league', 'efl'] },
  { id: 'spfl', label: 'Scottish Football', country: 'Scotland', isFootball: true, venueTz: 'Europe/London', keywords: ['spfl', 'scottish'] },
  { id: 'fa-cup', label: 'FA & League Cup', country: 'England', isFootball: true, venueTz: 'Europe/London', keywords: ['fa cup', 'league cup', 'carabao'] },
  { id: 'friendlies', label: 'Friendlies', country: 'World', isFootball: true, venueTz: 'Europe/London', keywords: ['friendly', 'psf'] },
  { id: 'mls', label: 'MLS', country: 'USA', isFootball: true, venueTz: 'America/New_York', keywords: ['mls'] },
  {
    id: 'football',
    label: 'Football',
    country: 'World',
    isFootball: true,
    venueTz: 'Europe/London',
    keywords: ['soccer', 'football', 'nations league', 'world cup', 'copa', 'a-league', 'fifa', 'liga mx', 'eredivisie', 'primeira']
  },
  { id: 'nfl', label: 'NFL', country: 'USA', isFootball: false, venueTz: 'America/New_York', keywords: ['nfl', 'ncaaf', 'college football', 'gridiron', 'xfl', 'ufl'] },
  { id: 'nba', label: 'NBA', country: 'USA', isFootball: false, venueTz: 'America/New_York', keywords: ['nba', 'ncaab', 'wnba', 'basketball'] },
  { id: 'nhl', label: 'NHL', country: 'World', isFootball: false, venueTz: 'America/New_York', keywords: ['nhl', 'hockey', 'ahl', 'qmjhl', 'ohl', 'whl'] },
  { id: 'mlb', label: 'MLB', country: 'USA', isFootball: false, venueTz: 'America/New_York', keywords: ['mlb', 'milb', 'baseball'] },
  { id: 'fighting', label: 'Fighting', country: 'World', isFootball: false, venueTz: null, keywords: ['ufc', 'boxing', 'wwe', 'wrestl', 'mma', 'bellator', 'pfl', 'fight'] },
  { id: 'tennis', label: 'Tennis', country: 'World', isFootball: false, venueTz: 'America/New_York', keywords: ['tennis', 'atp', 'wta', 'us open', 'wimbledon', 'roland'] },
  { id: 'cricket', label: 'Cricket', country: 'World', isFootball: false, venueTz: null, keywords: ['cricket', 'ipl', 'big bash', 't20', 'test match'] },
  { id: 'rugby', label: 'Rugby', country: 'World', isFootball: false, venueTz: 'Australia/Sydney', keywords: ['rugby', 'nrl', 'super league+'] },
  { id: 'motorsport', label: 'Motorsport', country: 'World', isFootball: false, venueTz: null, keywords: ['f1', 'formula', 'motorsport', 'nascar', 'rally', 'motogp', 'dirtvision', 'speedway'] },
  { id: 'aussie-rules', label: 'Aussie Rules', country: 'Australia', isFootball: false, venueTz: 'Australia/Sydney', keywords: ['aussie rules', 'afl'] },
  { id: 'golf', label: 'Golf', country: 'World', isFootball: false, venueTz: null, keywords: ['golf', 'pga', 'ryder'] },
  { id: 'darts-snooker', label: 'Darts & Cue Sports', country: 'World', isFootball: false, venueTz: null, keywords: ['darts', 'snooker', 'matchroom', 'ultimate pool'] }
]

// Categories that exist to carry broadcast channels rather than one competition's events.
// They no longer become browse groups — their channels go to the left pane's flat Channels
// list instead (the request: fewer categories, channels listed directly).
const CARRIER_CATEGORY_KEYWORDS = ['sky sports', 'tnt sports', 'espn', 'dazn', 'kayo', 'bar tv', 'flo', 'peacock', 'paramount', 'stan sport', 'fanatiz', 'nfhs', 'setanta', 'dstv', 'supersports', 'tennis channel', 'premier sports', 'now hk', 'astro sports', 'hub sports', 'gaago', 'clubber', 'trillertv', 'fight pass', 'apple tv', 'monomax', 'tod ', 'crowd']

/** Strips the provider's region/live prefixes ("USA | ", "Live | ", "EN✦ ") for display. */
export function cleanCategoryLabel(categoryName: string): string {
  return categoryName
    .replace(/^(?:live|replay)\s*\|\s*/i, '')
    .replace(/^[a-z]{2,4}\s*\|\s*/i, '')
    .replace(/^[a-z]{2,4}[*✦✆]\s*/i, '')
    .trim() || categoryName.trim()
}

/** A category's classification: a competition group, a carrier (channels only), or not sports. */
export type CategoryClass =
  | { kind: 'league'; rule: LeagueRule }
  | { kind: 'carrier' }

/**
 * Which competition a category belongs to (api-football-style leagues), whether it merely
 * carries broadcast channels, or null when it is not a sports category at all.
 */
export function classifyCategory(categoryName: string): CategoryClass | null {
  const name = categoryName.toLowerCase()
  for (const rule of LEAGUE_RULES) {
    if (rule.keywords.some((k) => name.includes(k))) return { kind: 'league', rule }
  }
  if (CARRIER_CATEGORY_KEYWORDS.some((k) => name.includes(k))) return { kind: 'carrier' }
  if (/\bsports?\b/.test(name)) return { kind: 'carrier' }
  return null
}

// --- Which platform sport each competition belongs to ------------------------------------------

/**
 * The sport id a competition rule belongs to — matching lib/api-sports.ts's source ids, which are
 * the api-football.com platform's own category ids. The left pane lists those categories, so this
 * is what ties the provider's parseable leagues (Football, NFL, NBA…) to one of them; a rule
 * without an entry (tennis, cricket, golf, darts) belongs to no platform sport and is simply not
 * listed under any category.
 */
const SPORT_OF_LEAGUE: Record<string, string> = {
  'premier-league': 'football', 'champions-league': 'football', 'europa-league': 'football',
  'conference-league': 'football', 'la-liga': 'football', 'serie-a': 'football',
  bundesliga: 'football', 'ligue-1': 'football', championship: 'football',
  'efl-leagues': 'football', spfl: 'football', 'fa-cup': 'football', friendlies: 'football',
  mls: 'football', football: 'football',
  nfl: 'nfl',
  nba: 'nba',
  nhl: 'hockey',
  mlb: 'baseball',
  fighting: 'mma',
  rugby: 'rugby',
  motorsport: 'formula-1',
  'aussie-rules': 'afl'
}

/** The platform sport a competition belongs to, or null when it isn't one of them. */
export function sportOfLeague(leagueId: string): string | null {
  return SPORT_OF_LEAGUE[leagueId] ?? null
}

// --- Event-name parsing -----------------------------------------------------------------------

// "EPL01: ", "US Open 10: ", "PSF 03 | ", "EPL 05ⓧ: " — some index-ish token followed by : or |.
const INDEX_PREFIX = /^.*?\d{1,3}[^\d\s:|]*\s*[:|]\s*/
const SEPARATOR = /\s+vs\.?\s+|\s+vs\s+|\s+v\s+/i
// Kickoff tokens, tried in order; first match wins.
const FULL_DATE = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*(\d{4})?\b/i
const DAY_MONTH_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?/i
// UK-order numeric date the provider also uses ("Fiorentina vs Napoli 20/09").
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/
const TIME = /\b(\d{1,2})[:.](\d{2})\s*([ap])\.?\s?m\.?\b|\b(\d{1,2})[:.](\d{2})\b/i
const TZ = /\b(UTC|GMT|BST|CET|CEST|EET|AEST|AEDT|ACST|AWST|JST|KST|HKT|SGT|ET|PT|CT|MT)(?:\s*([+-])\s*(\d{1,2}))?\b/i

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

// Fixed-offset interpretation for the common abbreviation suffixes. DST-correctness is out of
// scope on purpose: a kickoff landing an hour off in the day list is cosmetically wrong for a
// few weeks a year, while pulling in a tz database for name parsing is not worth it. Unknown
// or absent suffix → the time is taken as already-local.
const TZ_OFFSET_MINUTES: Record<string, number> = {
  utc: 0, gmt: 0, bst: 60, cet: 60, cest: 120, eet: 120,
  aest: 600, aedt: 660, acst: 570, awst: 480, jst: 540, kst: 540, hkt: 480, sgt: 480,
  et: -240, ct: -300, mt: -360, pt: -420
}

const EDGE_NOISE = new Set(['hd', 'fhd', 'uhd', '4k', 'sd', 'vip', 'feed', 'feeds', 'backup', 'multi', 'view', 'live', 'stream', 'en', 'es', 'world', 'feed1'])
const CLUB_SUFFIX = new Set(['fc', 'afc', 'sc', 'cf'])

/** Cleans one captured team side for display, and derives its match key. */
function cleanTeam(side: string): { display: string; key: string } {
  let working = side
    // Carrier annotations and kickoff metadata never live inside the team name itself.
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s*@\s*.*$/i, ' ')
    .replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, ' ')
    .replace(/\s*\|\s*.*$/g, ' ')
    // am/pm both letters, mandatory — a single optional [ap] would eat a leading "A"/"P"
    // of the team name ("15:00 Arsenal" → "rsenal").
    .replace(/\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?/gi, ' ')
    .trim()
  // Drop seed/rank markers glued to the first token ("(1) Zverev", "[3] Swiatek").
  working = working.replace(/^[[(]\d{1,2}[\])]\s*/, '')
  let tokens = working.split(/\s+/).filter(Boolean)
  while (tokens.length > 1 && EDGE_NOISE.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop()
  while (tokens.length > 1 && EDGE_NOISE.has(tokens[0].toLowerCase())) tokens = tokens.slice(1)
  const display = tokens.join(' ')
  const keyTokens = tokens
    .map((t) => t.toLowerCase())
    .filter((t) => !EDGE_NOISE.has(t))
  while (keyTokens.length > 1 && CLUB_SUFFIX.has(keyTokens[keyTokens.length - 1])) keyTokens.pop()
  return { display, key: keyTokens.join(' ') }
}

/** The match key of one team name, normalized through the same rules the schedule uses — the
 *  join point lib/fixtureMatch.ts compares API spellings against. */
export function teamMatchKey(name: string): string {
  return cleanTeam(name).key
}

function parseTimeToken(
  timeToken: string,
  base: Date,
  tzText?: string,
  venueHintTz?: string | null
): Date | null {
  const t = timeToken.match(TIME)
  if (!t) return null
  const h12 = t[1] !== undefined
  let hour = h12 ? Number(t[1]) : Number(t[4])
  const minute = h12 ? Number(t[2]) : Number(t[5])
  if (h12) {
    const isPm = t[3].toLowerCase() === 'p'
    if (isPm && hour < 12) hour += 12
    if (!isPm && hour === 12) hour = 0
  }
  if (hour > 23 || minute > 59) return null
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute)
  const tz = tzText?.match(TZ)
  if (tz && TZ_OFFSET_MINUTES[tz[1].toLowerCase()] !== undefined) {
    // Convert the wall-clock time interpreted in that zone into local time.
    const offsetMinutes = TZ_OFFSET_MINUTES[tz[1].toLowerCase()] + (tz[2] ? Number(`${tz[2]}${tz[3]}`) * 60 : 0)
    const asUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute) - offsetMinutes * 60_000
    return new Date(asUtc)
  }
  if (venueHintTz) {
    // Suffix-less time on a feed whose quoting zone is known from the category — interpret
    // the wall time there (DST-correct) instead of as viewer-local.
    return new Date(zonedWallToUtc(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, venueHintTz))
  }
  return date
}

/**
 * The venue-side wall time from the same text segment that produced a kickoff — the numbers as
 * written plus the tz suffix when the name carried one ("3:00 pm ET" → 15:00, "ET"). Mirrors
 * parseTimeToken's reading of the TIME/TZ patterns so the two can never disagree.
 */
function extractVenueTime(text: string): VenueTime | null {
  const t = text.match(TIME)
  if (!t) return null
  const h12 = t[1] !== undefined
  let hour = h12 ? Number(t[1]) : Number(t[4])
  const minute = h12 ? Number(t[2]) : Number(t[5])
  if (h12) {
    const isPm = t[3].toLowerCase() === 'p'
    if (isPm && hour < 12) hour += 12
    if (!isPm && hour === 12) hour = 0
  }
  if (hour > 23 || minute > 59) return null
  const tz = text.match(TZ)
  const tzLabel = tz ? tz[1].toUpperCase() + (tz[2] ? `${tz[2]}${tz[3]}` : '') : null
  return { hour, minute, tzLabel }
}

function extractKickoff(text: string, now: Date, venueHintTz?: string | null): Date | null {
  let day: { year: number; month: number; date: number; hadYear: boolean } | null = null
  const numeric = text.match(NUMERIC_DATE)
  if (numeric) {
    // UK order on this provider: 20/09 == 20 September.
    const dayNum = Number(numeric[1])
    const monthNum = Number(numeric[2])
    if (dayNum >= 1 && dayNum <= 31 && monthNum >= 1 && monthNum <= 12) {
      let year = numeric[3] ? Number(numeric[3]) : now.getFullYear()
      if (year < 100) year += 2000
      day = { year, month: monthNum - 1, date: dayNum, hadYear: Boolean(numeric[3]) }
    }
  }
  if (!day) {
    const dm = text.match(FULL_DATE) ?? text.match(DAY_MONTH_DATE)
    if (dm) {
      if (dm[2] !== undefined && MONTHS[dm[2].toLowerCase()] !== undefined) {
        // "11 Sep", "8 Sep 2026"
        const year = dm[3] ? Number(dm[3]) : now.getFullYear()
        day = { year, month: MONTHS[dm[2].toLowerCase()], date: Number(dm[1]), hadYear: Boolean(dm[3]) }
      } else if (dm[1] !== undefined && MONTHS[dm[1]?.toLowerCase()] !== undefined) {
        // "Sep 11"
        const year = dm[3] ? Number(dm[3]) : now.getFullYear()
        day = { year, month: MONTHS[dm[1].toLowerCase()], date: Number(dm[2]), hadYear: Boolean(dm[3]) }
      }
    }
  }
  const timeToken = text.match(TIME)?.[0]
  if (!day) {
    if (!timeToken) return null
    // Time only ("@ 3:00 pm") — the provider lists current fixtures, so that is today; a
    // kickoff already several hours gone is tomorrow's fixture in this naming style.
    const today = parseTimeToken(timeToken, now, text, venueHintTz)
    if (!today) return null
    return today.getTime() < now.getTime() - 6 * 3_600_000 ? new Date(today.getTime() + 86_400_000) : today
  }

  // A date without a year that would sit far in the past is next year's fixture.
  let candidate = new Date(day.year, day.month, day.date)
  if (!day.hadYear && candidate.getTime() < now.getTime() - 45 * 86_400_000) {
    candidate = new Date(day.year + 1, day.month, day.date)
  }
  const withTime = timeToken ? parseTimeToken(timeToken, candidate, text, venueHintTz) : null
  return withTime ?? new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate(), 12)
}

/**
 * Parses one channel name into a matchup, or null when the channel is a carrier ("Sky Sports
 * Main Event UHD", "NRL : NEWCASTLE KNIGHTS") rather than a specific event. `venueHintTz` is
 * the quoting zone of the category this channel lives in (see classifyCategory) — it governs
 * suffix-less kickoff times and names the venue side of the dual-time display.
 */
export function parseEventName(
  rawName: string,
  now: Date = new Date(),
  venueHintTz?: string | null
): ParsedEvent | null {
  const body = rawName.replace(INDEX_PREFIX, '')
  const separatorMatch = body.match(SEPARATOR)
  let left: string
  let right: string
  if (separatorMatch && separatorMatch.index !== undefined) {
    left = body.slice(0, separatorMatch.index)
    right = body.slice(separatorMatch.index + separatorMatch[0].length)
  } else {
    // The index-category form has no "vs" at all: "EPL01: Brentford 20:00 Chelsea" — a bare
    // kickoff time sits between the two teams. Require team-ish text on both sides and let
    // cleanTeam reject decoration-only sides.
    const timedForm = body.match(/^([^@|]*?)\s+(\d{1,2}[:.]\d{2})\s+([^@|]+)$/)
    if (!timedForm) return null
    left = timedForm[1]
    right = `${timedForm[3]} @ ${timedForm[2]}`
  }
  if (!left.trim() || !right.trim()) return null

  // Competition descriptors precede the teams with a colon ("League Cup: Sunderland"), and
  // event-title context rides in with " - " separators before the actual home team
  // ("NHRL Grand Final - A Grade Ladies League Tag - Central Newcastle v ..."). In both cases
  // the real team is the LAST segment. Only ever applied to the home side; the away side sits
  // after the separator by construction. The colon rule ignores prefixes containing digits —
  // "16:00 Newcastle United" is a kickoff time, not a competition label.
  const colonIdx = left.lastIndexOf(':')
  if (colonIdx > 0) {
    const prefix = left.slice(0, colonIdx)
    // Two shapes are prefixes, never team names: word-only competition labels ("League Cup:")
    // and short letter+digits index codes ("EPL01:", "PSF7:"). A prefix containing digits AND
    // other characters ("16:00") is a kickoff time and must survive.
    if (!/\d/.test(prefix) || /^[A-Za-z]{1,6}\d{0,3}$/.test(prefix.replace(/\s+/g, ''))) {
      left = left.slice(colonIdx + 1)
    }
  }
  const dashSegments = left.split(' - ')
  if (dashSegments.length > 1) left = dashSegments[dashSegments.length - 1]
  left = left.trim()

  const home = cleanTeam(left)
  const away = cleanTeam(right)
  // A side that normalizes away to nothing (pure decoration) is not a matchup.
  if (!home.display || !away.display) return null
  if (!home.key || !away.key || home.key === away.key) return null

  // Kickoff comes from the tail of the name (after the separator) — "@ Sep 11 2:00PM ET",
  // "| Saturday, 19 September 2026 15:00" — or from a bare time between the teams
  // ("Brentford 20:00 Chelsea"), which the separator-less form uses. The pipe form carries
  // its time on the LEFT ("PSF 03 | 16:00 Newcastle United vs Strasbourg"), so the left side
  // is the fallback when the right yields nothing.
  let kickoff = extractKickoff(right, now, venueHintTz)
  let venueTime: VenueTime | null = kickoff ? extractVenueTime(right) : null
  if (!kickoff && separatorMatch) {
    kickoff = extractKickoff(left, now, venueHintTz)
    venueTime = kickoff ? extractVenueTime(left) : null
  }
  if (!kickoff) {
    const bareTime = left.match(/\b(\d{1,2}[:.]\d{2})\s*$/)
    const bareRight = right.match(/^\s*(\d{1,2}[:.]\d{2})\b/)
    if (bareTime) {
      const timeDate = parseTimeToken(
        `${bareTime[1]} ${now.getFullYear()}`,
        new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        undefined,
        venueHintTz
      )
      if (timeDate) {
        // A kickoff already several hours gone is tomorrow's fixture in this naming style.
        kickoff = timeDate.getTime() < now.getTime() - 6 * 3_600_000
          ? new Date(timeDate.getTime() + 86_400_000)
          : timeDate
        venueTime = extractVenueTime(bareTime[1])
      }
    } else if (bareRight) {
      kickoff = parseTimeToken(
        bareRight[1],
        new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        undefined,
        venueHintTz
      )
      venueTime = extractVenueTime(bareRight[1])
    }
  }
  // A suffix-less wall time interpreted via the category's zone gets that zone's name (at the
  // actual kickoff instant, so BST vs GMT is right) on the venue side of the display.
  if (kickoff && venueTime && !venueTime.tzLabel && venueHintTz) {
    venueTime = { ...venueTime, tzLabel: shortZoneName(kickoff.getTime(), venueHintTz) }
  }

  return {
    homeDisplay: home.display,
    awayDisplay: away.display,
    homeKey: home.key,
    awayKey: away.key,
    kickoff,
    venueTime
  }
}

// --- Schedule assembly ------------------------------------------------------------------------

export function dayKeyOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Builds the sports schedule from the whole live catalog: categories classify into api-football
 * style competitions (Premier League, La Liga, NFL…), event-named channels group into games by
 * normalized team pair + local day across every category carrying them, and carrier categories
 * contribute their channels to one flat list for the left pane.
 */
export function buildSportsSchedule(streams: LiveStream[], categories: Category[], now: Date = new Date()): SportsSchedule {
  const categoryClass = new Map<string, CategoryClass>()
  for (const category of categories) {
    const cls = classifyCategory(category.category_name)
    if (cls) categoryClass.set(category.category_id, cls)
  }

  const groupsById = new Map<string, SportsGroup>()
  const carrierChannels: LiveStream[] = []
  const gamesByKey = new Map<string, SportsGame>()
  for (const stream of streams) {
    const cls = categoryClass.get(stream.category_id)
    if (!cls) continue

    if (cls.kind === 'carrier') {
      carrierChannels.push(stream)
      continue
    }

    const rule = cls.rule
    let group = groupsById.get(rule.id)
    if (!group) {
      group = {
        id: rule.id,
        label: rule.label,
        country: rule.country,
        isFootball: rule.isFootball,
        categoryIds: [],
        channelCount: 0,
        venueTz: rule.venueTz
      }
      groupsById.set(rule.id, group)
    }
    if (!group.categoryIds.includes(stream.category_id)) group.categoryIds.push(stream.category_id)
    group.channelCount += 1

    const event = parseEventName(stream.name, now, rule.venueTz)
    if (!event) continue
    const dayKey = event.kickoff ? dayKeyOf(event.kickoff) : null
    const pair = [event.homeKey, event.awayKey].sort().join(' vs ')
    const key = `${rule.id}|${dayKey ?? 'unscheduled'}|${pair}`
    let game = gamesByKey.get(key)
    if (!game) {
      game = {
        key,
        leagueId: rule.id,
        pairKey: pair,
        homeDisplay: event.homeDisplay,
        awayDisplay: event.awayDisplay,
        dayKey,
        kickoff: event.kickoff,
        venueTime: event.venueTime,
        channels: []
      }
      gamesByKey.set(key, game)
    }
    game.channels.push(stream)
  }

  const gamesByLeague: Record<string, SportsGame[]> = {}
  for (const game of gamesByKey.values()) {
    game.channels.sort((a, b) => a.num - b.num)
    const list = gamesByLeague[game.leagueId] ?? []
    list.push(game)
    gamesByLeague[game.leagueId] = list
  }
  for (const list of Object.values(gamesByLeague)) {
    // Scheduled games first (earliest kickoff at top), unscheduled after, alphabetically.
    list.sort((a, b) => {
      if (a.kickoff && b.kickoff) return a.kickoff.getTime() - b.kickoff.getTime()
      if (a.kickoff) return -1
      if (b.kickoff) return 1
      return `${a.homeDisplay} vs ${a.awayDisplay}`.localeCompare(`${b.homeDisplay} vs ${b.awayDisplay}`)
    })
  }

  const leagues = [...groupsById.values()].sort((a, b) => {
    if (a.isFootball !== b.isFootball) return a.isFootball ? -1 : 1
    if (b.channelCount !== a.channelCount) return b.channelCount - a.channelCount
    return a.label.localeCompare(b.label)
  })
  carrierChannels.sort((a, b) => a.num - b.num)

  return { leagues, gamesByLeague, channels: carrierChannels }
}

/** Games for one local day (dayKey from dayKeyOf), kickoff-ordered. */
export function gamesForDay(games: SportsGame[], dayKey: string): SportsGame[] {
  return games.filter((game) => game.dayKey === dayKey)
}
