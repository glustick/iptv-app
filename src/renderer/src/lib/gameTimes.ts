// Dual-timezone kickoff formatting for the Sports tab: every scheduled time is shown in the
// venue's timezone AND the viewer's local timezone, so an EPL 15:00 London kickoff reads as
// "15:00 BST · 22:00" (no guessing) for a UTC+7 viewer instead of one ambiguous number.
//
// Two sources feed this, with different knowledge:
//  - Provider channel names carry a wall time as written plus an optional tz abbreviation
//    ("3:00 pm ET", "15:00") — that wall time is displayed verbatim (see lib/sports.ts, which
//    retains it), and only the local side is computed here from the kickoff instant.
//  - api-football fixtures carry a UTC instant and a league COUNTRY, not a venue zone — the
//    country is mapped to the league's primary IANA zone below (DST-correct via Intl).
//
// Pure module: no window/document/Electron imports (docs/STATE.md), unit-tested directly.

export interface DualTime {
  /** Venue-side wall clock, e.g. "15:00 BST" (tz name included when known). */
  venue: string
  /** Viewer-local wall clock, e.g. "22:00" — plus "+1d"/"-1d" when it lands on another day. */
  local: string
  /** True when both sides show the same wall numbers — the UI then renders one time only. */
  sameWall: boolean
}

// api-football league.country → the zone that league's kickoffs are quoted in. A country-wide
// primary zone for the big football nations; multi-zone countries use the zone most of that
// country's league football is played in (US: ET), which the venue tz name shown next to the
// time keeps honest. Anything unmapped falls back to UTC (also correct for "World").
const COUNTRY_TIMEZONES: Record<string, string> = {
  england: 'Europe/London', scotland: 'Europe/London', wales: 'Europe/London',
  'northern ireland': 'Europe/London', ireland: 'Europe/Dublin',
  spain: 'Europe/Madrid', italy: 'Europe/Rome', germany: 'Europe/Berlin', france: 'Europe/Paris',
  netherlands: 'Europe/Amsterdam', portugal: 'Europe/Lisbon', belgium: 'Europe/Brussels',
  switzerland: 'Europe/Zurich', austria: 'Europe/Vienna', poland: 'Europe/Warsaw',
  denmark: 'Europe/Copenhagen', norway: 'Europe/Oslo', sweden: 'Europe/Stockholm',
  greece: 'Europe/Athens', turkey: 'Europe/Istanbul', ukraine: 'Europe/Kyiv',
  russia: 'Europe/Moscow', israel: 'Asia/Jerusalem',
  'saudi arabia': 'Asia/Riyadh', uae: 'Asia/Dubai', qatar: 'Asia/Qatar', iran: 'Asia/Tehran',
  japan: 'Asia/Tokyo', 'south korea': 'Asia/Seoul', china: 'Asia/Shanghai',
  india: 'Asia/Kolkata', thailand: 'Asia/Bangkok', indonesia: 'Asia/Jakarta',
  australia: 'Australia/Sydney', 'new zealand': 'Pacific/Auckland',
  usa: 'America/New_York', canada: 'America/Toronto', mexico: 'America/Mexico_City',
  'costa rica': 'America/Costa_Rica', honduras: 'America/Tegucigalpa', panama: 'America/Panama',
  brazil: 'America/Sao_Paulo', argentina: 'America/Argentina/Buenos_Aires',
  chile: 'America/Santiago', colombia: 'America/Bogota', peru: 'America/Lima',
  ecuador: 'America/Guayaquil', uruguay: 'America/Montevideo', paraguay: 'America/Asuncion',
  venezuela: 'America/Caracas', bolivia: 'America/La_Paz',
  egypt: 'Africa/Cairo', morocco: 'Africa/Casablanca', algeria: 'Africa/Algiers',
  tunisia: 'Africa/Tunis', 'south africa': 'Africa/Johannesburg', nigeria: 'Africa/Lagos',
  ghana: 'Africa/Accra', kenya: 'Africa/Nairobi'
}

/** The IANA zone a league-country's kickoffs are quoted in; UTC when unknown. */
export function venueTimezoneForCountry(country: string): string {
  return COUNTRY_TIMEZONES[country.trim().toLowerCase()] ?? 'UTC'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

interface ZonedWall {
  hour: number
  minute: number
  /** Short tz abbreviation as valid on that instant ("BST", "ET"), or "UTC" for the raw zone. */
  tzName: string
  /** Comparable calendar day, e.g. "2026-09-27" — used for the +1d/-1d marker. */
  ymd: string
}

function wallInZone(ms: number, tz: string): ZonedWall {
  const parts = new Intl.DateTimeFormat('en-CA', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: tz,
    timeZoneName: 'short'
  }).formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  // Some environments format the hour as "24" at midnight on the h23 cycle; normalize.
  const hour = get('hour') === '24' ? 0 : Number(get('hour'))
  return { hour, minute: Number(get('minute')), tzName: get('timeZoneName') || tz, ymd: `${get('year')}-${get('month')}-${get('day')}` }
}

function withDayShift(time: string, localYmd: string, venueYmd: string): string {
  if (localYmd === venueYmd) return time
  const [ly, lm, ld] = localYmd.split('-').map(Number)
  const [vy, vm, vd] = venueYmd.split('-').map(Number)
  const localDay = Date.UTC(ly, lm - 1, ld)
  const venueDay = Date.UTC(vy, vm - 1, vd)
  const days = Math.round((localDay - venueDay) / 86_400_000)
  return days > 0 ? `${time} +${days}d` : `${time} ${days}d`
}

function clockText(h: number, m: number, hour12: boolean): string {
  if (!hour12) return `${pad2(h)}:${pad2(m)}`
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${pad2(m)} ${ampm}`
}

/**
 * Fixture path: a UTC kickoff instant plus the venue's IANA zone (from the league country).
 * `localTz` is injectable for deterministic tests; defaults to the viewer's zone.
 */
export function formatDualFromInstant(
  ms: number,
  venueTz: string,
  hour12 = false,
  localTz: string | undefined = undefined
): DualTime {
  const venue = wallInZone(ms, venueTz)
  const local = wallInZone(ms, localTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const fmt = (h: number, m: number): string => clockText(h, m, hour12)
  return {
    venue: `${fmt(venue.hour, venue.minute)} ${venue.tzName}`,
    local: withDayShift(fmt(local.hour, local.minute), local.ymd, venue.ymd),
    sameWall: venue.hour === local.hour && venue.minute === local.minute
  }
}

/**
 * Provider path: the wall time exactly as parsed from the channel name plus its optional tz
 * abbreviation — displayed verbatim (no re-derivation), with only the local side computed from
 * the kickoff instant the parser already produced.
 */
export function formatDualFromWall(
  hour: number,
  minute: number,
  tzLabel: string | null,
  kickoffMs: number,
  hour12 = false,
  localTz: string | undefined = undefined
): DualTime {
  const dual = formatDualFromInstant(kickoffMs, 'UTC', hour12, localTz)
  const fmt = (h: number, m: number): string => clockText(h, m, hour12)
  return {
    venue: tzLabel ? `${fmt(hour, minute)} ${tzLabel}` : fmt(hour, minute),
    local: dual.local,
    sameWall: tzLabel === null
  }
}

/** One string for a row: both sides when they differ, a single time when they don't. */
export function dualTimeLabel(dual: DualTime): string {
  return dual.sameWall ? dual.venue : `${dual.venue} · ${dual.local}`
}

// --- Zone arithmetic for provider names without a tz suffix -----------------------------------
//
// The provider quotes most kickoffs as bare wall times ("… | Saturday 15:00") whose zone is the
// FEED's zone, not the viewer's — an EPL name on a UK feed means 15:00 London. The category a
// channel lives in carries that signal (see classifyCategory's venue hints), and these helpers
// turn a wall time + IANA zone into the correct instant, DST included.

function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms))
  const get = (t: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - ms
}

/** Wall-clock time in `tz` → UTC instant; two passes so a DST boundary is resolved correctly. */
export function zonedWallToUtc(
  year: number,
  monthIndex: number,
  date: number,
  hour: number,
  minute: number,
  tz: string
): number {
  const guess = Date.UTC(year, monthIndex, date, hour, minute)
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz)
}

/** The zone's short abbreviation as valid at an instant ("BST", "GMT", "ET") — DST-correct. */
export function shortZoneName(ms: number, tz: string): string {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'timeZoneName')?.value
  return name ?? tz
}

/** The same, as an offset name ("GMT+8", "GMT+5:30") — uniform across regions; falls back to the
 *  short name on engines without `shortOffset`. */
function shortOffsetName(ms: number, tz: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(ms))
      .find((p) => p.type === 'timeZoneName')?.value
    if (name) return name
  } catch {
    // Older engines: fall through to the short name.
  }
  return shortZoneName(ms, tz)
}

/**
 * The viewer-local kickoff clock with the local system timezone in parentheses — "19:45 (GMT+8)".
 *
 * This is the Sports tab's requested time format (2026-09-29): the local time of the kickoff
 * first, then the local system timezone in brackets. `localTz` is injectable for deterministic
 * tests; it defaults to the viewer's own zone.
 */
export function localKickoffLabel(ms: number, hour12 = false, localTz: string | undefined = undefined): string {
  const tz = localTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const wall = wallInZone(ms, tz)
  return `${clockText(wall.hour, wall.minute, hour12)} (${shortOffsetName(ms, tz)})`
}
