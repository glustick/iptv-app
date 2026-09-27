import { describe, it, expect } from 'vitest'
import {
  venueTimezoneForCountry,
  formatDualFromInstant,
  formatDualFromWall,
  dualTimeLabel,
  zonedWallToUtc,
  shortZoneName
} from './gameTimes'

// Deterministic throughout: the viewer zone is injected as Asia/Kuala_Lumpur (UTC+8, no DST).
const VIEWER_TZ = 'Asia/Kuala_Lumpur'

describe('venueTimezoneForCountry', () => {
  it('maps the major football nations, case-insensitively', () => {
    expect(venueTimezoneForCountry('England')).toBe('Europe/London')
    expect(venueTimezoneForCountry('SPAIN')).toBe('Europe/Madrid')
    expect(venueTimezoneForCountry(' Japan ')).toBe('Asia/Tokyo')
  })

  it('falls back to UTC for unmapped countries', () => {
    expect(venueTimezoneForCountry('Atlantis')).toBe('UTC')
  })
})

describe('formatDualFromInstant', () => {
  it('shows the venue wall clock with its DST-correct tz name, plus the local one', () => {
    // 2026-09-27 14:00Z = 15:00 BST (London, summer) = 22:00 in UTC+8. The tz abbreviation is
    // ICU-dependent (full-ICU builds say "BST"; Node's small-ICU says "GMT+1") — both state the
    // same instant's offset, so accept either.
    const dual = formatDualFromInstant(Date.UTC(2026, 8, 27, 14, 0), 'Europe/London', false, VIEWER_TZ)
    expect(dual.venue).toMatch(/^15:00 (BST|GMT\+1)$/)
    expect(dual.local).toBe('22:00')
    expect(dual.sameWall).toBe(false)
  })

  it('switches the venue tz name with the season (GMT in winter)', () => {
    const dual = formatDualFromInstant(Date.UTC(2026, 0, 15, 15, 0), 'Europe/London', false, VIEWER_TZ)
    expect(dual.venue).toBe('15:00 GMT')
    expect(dual.local).toBe('23:00')
  })

  it('marks a local time that lands on the next calendar day', () => {
    // 20:00 BST = 19:00Z = 03:00 next day at UTC+8.
    const dual = formatDualFromInstant(Date.UTC(2026, 8, 27, 19, 0), 'Europe/London', false, VIEWER_TZ)
    expect(dual.local).toBe('03:00 +1d')
  })

  it('collapses to a single time when both zones read the same numbers', () => {
    const dual = formatDualFromInstant(Date.UTC(2026, 8, 27, 14, 0), VIEWER_TZ, false, VIEWER_TZ)
    expect(dual.sameWall).toBe(true)
    expect(dualTimeLabel(dual)).toBe(dual.venue)
  })

  it('formats 12-hour clock times on request', () => {
    const dual = formatDualFromInstant(Date.UTC(2026, 8, 27, 14, 0), 'Europe/London', true, VIEWER_TZ)
    expect(dual.venue).toMatch(/^3:00 pm (BST|GMT\+1)$/)
    expect(dual.local).toBe('10:00 pm')
  })
})

describe('zonedWallToUtc / shortZoneName', () => {
  it('converts a wall time in a zone to the right instant across the DST boundary', () => {
    // 15:00 London in September (BST, UTC+1) vs January (GMT, UTC+0).
    expect(zonedWallToUtc(2026, 8, 27, 15, 0, 'Europe/London')).toBe(Date.UTC(2026, 8, 27, 14, 0))
    expect(zonedWallToUtc(2026, 0, 16, 15, 0, 'Europe/London')).toBe(Date.UTC(2026, 0, 16, 15, 0))
    expect(zonedWallToUtc(2026, 8, 27, 15, 0, VIEWER_TZ)).toBe(Date.UTC(2026, 8, 27, 7, 0))
  })

  it('names the zone as valid at the instant', () => {
    expect(shortZoneName(Date.UTC(2026, 8, 27, 14, 0), 'Europe/London')).toMatch(/^(BST|GMT\+1)$/)
    expect(shortZoneName(Date.UTC(2026, 0, 16, 15, 0), 'Europe/London')).toMatch(/^(GMT|UTC|GMT\+0)$/)
  })
})

describe('formatDualFromWall', () => {
  it('keeps the provider wall time and tz label verbatim, deriving only the local side', () => {
    // "3:00 pm ET" = 19:00Z = 03:00 +1d at UTC+8.
    const dual = formatDualFromWall(15, 0, 'ET', Date.UTC(2026, 8, 27, 19, 0), false, VIEWER_TZ)
    expect(dual.venue).toBe('15:00 ET')
    expect(dual.local).toBe('03:00 +1d')
    expect(dual.sameWall).toBe(false)
    expect(dualTimeLabel(dual)).toBe('15:00 ET · 03:00 +1d')
  })

  it('renders a single time when the name carried no tz suffix (wall time was already local)', () => {
    const dual = formatDualFromWall(20, 0, null, Date.UTC(2026, 8, 27, 12, 0), false, VIEWER_TZ)
    expect(dual.venue).toBe('20:00')
    expect(dual.sameWall).toBe(true)
    expect(dualTimeLabel(dual)).toBe('20:00')
  })
})
