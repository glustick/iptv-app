import type { Category, LiveStream } from './types'

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
  label: string
  /** True for the Football / Soccer group — always sorted to the top of the list. */
  isFootball: boolean
  categoryIds: string[]
  channelCount: number
}

export interface ParsedEvent {
  homeDisplay: string
  awayDisplay: string
  /** Normalized match keys — equal keys mean the same team regardless of formatting. */
  homeKey: string
  awayKey: string
  /** Local-time kickoff when the name carries a usable date/time; null → "Unscheduled". */
  kickoff: Date | null
}

export interface SportsGame {
  key: string
  sportId: string
  homeDisplay: string
  awayDisplay: string
  /** Local calendar day (YYYY-MM-DD) the kickoff lands on, or null when unscheduled. */
  dayKey: string | null
  kickoff: Date | null
  channels: LiveStream[]
}

export interface SportsSchedule {
  sports: SportsGroup[]
  /** sport id → every parsed game for that sport (all days; the view filters by day). */
  gamesBySport: Record<string, SportsGame[]>
}

// --- Category classification -----------------------------------------------------------------

interface SportRule {
  id: string
  label: string
  keywords: string[]
}

// Order matters: the first matching rule wins, so specific codes (NFL, IPL) must precede the
// generic terms they'd otherwise be swallowed by ("premier league" would eat "Indian Premier
// League", "football" would eat "NFL Football").
const SPORT_RULES: SportRule[] = [
  { id: 'american-football', label: 'American Football', keywords: ['nfl', 'ncaaf', 'college football', 'gridiron', 'xfl', 'ufl'] },
  { id: 'cricket', label: 'Cricket', keywords: ['cricket', 'ipl', 'big bash', 't20', 'test match'] },
  { id: 'basketball', label: 'Basketball', keywords: ['nba', 'basketball', 'ncaab', 'wnba'] },
  { id: 'ice-hockey', label: 'Ice Hockey', keywords: ['nhl', 'hockey', 'ahl', 'qmjhl', 'ohl', 'whl'] },
  { id: 'baseball', label: 'Baseball', keywords: ['mlb', 'milb', 'baseball'] },
  { id: 'fighting', label: 'Fighting', keywords: ['ufc', 'boxing', 'fight', 'wwe', 'wrestl', 'mma', 'bellator', 'pfl'] },
  { id: 'tennis', label: 'Tennis', keywords: ['tennis', 'atp', 'wta', 'us open', 'wimbledon', 'roland'] },
  { id: 'motorsport', label: 'Motorsport', keywords: ['f1', 'formula', 'motorsport', 'nascar', 'rally', 'motogp', 'dirtvision', 'speedway'] },
  { id: 'rugby', label: 'Rugby', keywords: ['rugby', 'nrl', 'super league+', 'ki_option'] },
  { id: 'aussie-rules', label: 'Aussie Rules', keywords: ['afl'] },
  { id: 'golf', label: 'Golf', keywords: ['golf', 'pga', 'ryder'] },
  { id: 'darts-snooker', label: 'Darts & Cue Sports', keywords: ['darts', 'snooker', 'matchroom', 'ultimate pool'] },
  {
    id: 'football',
    label: 'Football / Soccer',
    keywords: [
      'soccer', 'football', 'epl', 'premier league', 'championship', 'la liga', 'serie a',
      'bundesliga', 'ligue', 'spfl', 'uefa', 'fifa', 'fa cup', 'league cup', 'efl', 'mls',
      'a-league', 'world cup', 'nations league', 'copa', 'europa', 'conf. league'
    ]
  }
]

// Categories that exist to carry broadcast channels rather than one event each (every Sky
// Sports/TNT/ESPN-style channel lives here). They still surface in Sports — as their own
// browse group — but under a cleaned-up name rather than a sport label.
const CARRIER_CATEGORY_KEYWORDS = ['sky sports', 'tnt sports', 'espn', 'dazn', 'kayo', 'bar tv', 'flo', 'peacock', 'paramount', 'stan sport', 'fanatiz', 'nfhs', 'setanta', 'dstv', 'supersports', 'tennis channel', 'premier sports', 'now hk', 'astro sports', 'hub sports', 'gaago', 'clubber', 'trillertv', 'fight pass', 'apple tv', 'monomax', 'tod ', 'crowd']

/** Strips the provider's region/live prefixes ("USA | ", "Live | ", "EN✦ ") for display. */
export function cleanCategoryLabel(categoryName: string): string {
  return categoryName
    .replace(/^(?:live|replay)\s*\|\s*/i, '')
    .replace(/^[a-z]{2,4}\s*\|\s*/i, '')
    .replace(/^[a-z]{2,4}[*✦✆]\s*/i, '')
    .trim() || categoryName.trim()
}

/** Which sport a category belongs to, or null when it is not a sports category at all. */
export function classifyCategory(categoryName: string): { id: string; label: string } | null {
  const name = categoryName.toLowerCase()
  for (const rule of SPORT_RULES) {
    if (rule.keywords.some((k) => name.includes(k))) return { id: rule.id, label: rule.label }
  }
  if (CARRIER_CATEGORY_KEYWORDS.some((k) => name.includes(k))) {
    return { id: `carrier:${cleanCategoryLabel(categoryName).toLowerCase()}`, label: cleanCategoryLabel(categoryName) }
  }
  if (/\bsports?\b/.test(name)) {
    return { id: `carrier:${cleanCategoryLabel(categoryName).toLowerCase()}`, label: cleanCategoryLabel(categoryName) }
  }
  return null
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

function parseTimeToken(timeToken: string, base: Date, tzText?: string): Date | null {
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
  return date
}

function extractKickoff(text: string, now: Date): Date | null {
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
    const today = parseTimeToken(timeToken, now, text)
    if (!today) return null
    return today.getTime() < now.getTime() - 6 * 3_600_000 ? new Date(today.getTime() + 86_400_000) : today
  }

  // A date without a year that would sit far in the past is next year's fixture.
  let candidate = new Date(day.year, day.month, day.date)
  if (!day.hadYear && candidate.getTime() < now.getTime() - 45 * 86_400_000) {
    candidate = new Date(day.year + 1, day.month, day.date)
  }
  const withTime = timeToken ? parseTimeToken(timeToken, candidate, text) : null
  return withTime ?? new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate(), 12)
}

/**
 * Parses one channel name into a matchup, or null when the channel is a carrier ("Sky Sports
 * Main Event UHD", "NRL : NEWCASTLE KNIGHTS") rather than a specific event.
 */
export function parseEventName(rawName: string, now: Date = new Date()): ParsedEvent | null {
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
  let kickoff = extractKickoff(right, now)
  if (!kickoff && separatorMatch) kickoff = extractKickoff(left, now)
  if (!kickoff) {
    const bareTime = left.match(/\b(\d{1,2}[:.]\d{2})\s*$/)
    const bareRight = right.match(/^\s*(\d{1,2}[:.]\d{2})\b/)
    if (bareTime) {
      const timeDate = parseTimeToken(`${bareTime[1]} ${now.getFullYear()}`, new Date(now.getFullYear(), now.getMonth(), now.getDate()))
      if (timeDate) {
        // A kickoff already several hours gone is tomorrow's fixture in this naming style.
        kickoff = timeDate.getTime() < now.getTime() - 6 * 3_600_000
          ? new Date(timeDate.getTime() + 86_400_000)
          : timeDate
      }
    } else if (bareRight) {
      kickoff = parseTimeToken(bareRight[1], new Date(now.getFullYear(), now.getMonth(), now.getDate()))
    }
  }

  return {
    homeDisplay: home.display,
    awayDisplay: away.display,
    homeKey: home.key,
    awayKey: away.key,
    kickoff
  }
}

// --- Schedule assembly ------------------------------------------------------------------------

export function dayKeyOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Builds the full sports schedule from the whole live catalog. Categories classify into sport
 * groups (Football / Soccer pinned first, then by channel count); event-named channels group
 * into games by normalized team pair + local day, across every category that carries them.
 */
export function buildSportsSchedule(streams: LiveStream[], categories: Category[], now: Date = new Date()): SportsSchedule {
  const categoryToSport = new Map<string, { id: string; label: string }>()
  for (const category of categories) {
    const sport = classifyCategory(category.category_name)
    if (sport) categoryToSport.set(category.category_id, sport)
  }

  const groupsById = new Map<string, SportsGroup>()
  for (const [categoryId, sport] of categoryToSport) {
    let group = groupsById.get(sport.id)
    if (!group) {
      group = { id: sport.id, label: sport.label, isFootball: sport.id === 'football', categoryIds: [], channelCount: 0 }
      groupsById.set(sport.id, group)
    }
    if (!group.categoryIds.includes(categoryId)) group.categoryIds.push(categoryId)
  }

  const gamesByKey = new Map<string, SportsGame>()
  for (const stream of streams) {
    const sport = categoryToSport.get(stream.category_id)
    if (!sport) continue
    const group = groupsById.get(sport.id)
    if (group) group.channelCount += 1

    const event = parseEventName(stream.name, now)
    if (!event) continue
    const dayKey = event.kickoff ? dayKeyOf(event.kickoff) : null
    const pair = [event.homeKey, event.awayKey].sort().join(' vs ')
    const key = `${sport.id}|${dayKey ?? 'unscheduled'}|${pair}`
    let game = gamesByKey.get(key)
    if (!game) {
      game = {
        key,
        sportId: sport.id,
        homeDisplay: event.homeDisplay,
        awayDisplay: event.awayDisplay,
        dayKey,
        kickoff: event.kickoff,
        channels: []
      }
      gamesByKey.set(key, game)
    }
    game.channels.push(stream)
  }

  const gamesBySport: Record<string, SportsGame[]> = {}
  for (const game of gamesByKey.values()) {
    game.channels.sort((a, b) => a.num - b.num)
    const list = gamesBySport[game.sportId] ?? []
    list.push(game)
    gamesBySport[game.sportId] = list
  }
  for (const list of Object.values(gamesBySport)) {
    // Scheduled games first (earliest kickoff at top), unscheduled after, alphabetically.
    list.sort((a, b) => {
      if (a.kickoff && b.kickoff) return a.kickoff.getTime() - b.kickoff.getTime()
      if (a.kickoff) return -1
      if (b.kickoff) return 1
      return `${a.homeDisplay} vs ${a.awayDisplay}`.localeCompare(`${b.homeDisplay} vs ${b.awayDisplay}`)
    })
  }

  const sports = [...groupsById.values()].sort((a, b) => {
    if (a.isFootball !== b.isFootball) return a.isFootball ? -1 : 1
    if (b.channelCount !== a.channelCount) return b.channelCount - a.channelCount
    return a.label.localeCompare(b.label)
  })

  return { sports, gamesBySport }
}

/** Games for one local day (dayKey from dayKeyOf), kickoff-ordered. */
export function gamesForDay(games: SportsGame[], dayKey: string): SportsGame[] {
  return games.filter((game) => game.dayKey === dayKey)
}
