// api-football.com fixture data for the Sports tab (v0.8.0-alpha). Requests go through the
// `api-football:fetch` IPC bridge (main pins the host and injects the x-apisports-key header);
// this module owns the response shape and the normalization into what the UI renders.
//
// Without a configured key the Sports tab simply keeps its provider-channel schedule (the
// existing lib/sports.ts flow) — an empty fixture list here is a normal state, not an error.

/** One entry of api-football's `response[]` array on /fixtures. */
export interface RawFixture {
  fixture: { id: number; date: string; status: { short: string; long: string } }
  goals: { home: number | null; away: number | null }
  teams: { home: { name: string; logo: string }; away: { name: string; logo: string } }
  league: { name: string; country: string; round: string; season: number }
}

/** The normalized shape SportsView renders: teams, score, and where the match is in its lifecycle. */
export interface ApiFootballFixture {
  id: number
  kickoff: Date | null
  league: string
  country: string
  round: string
  homeTeam: string
  awayTeam: string
  homeGoals: number | null
  awayGoals: number | null
  live: boolean
  finished: boolean
  statusLong: string
}

// api-football status.short codes: in-play variants vs. terminal ones. "NS" (not started) and
// the pre/post variants (TBD, PST, CANC, ABD, SUSP, AWD, WO) are deliberately in neither set —
// a postponed match is neither live nor finished, and the UI should show it as scheduled.
const LIVE_SHORT_STATUSES = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'])
const FINISHED_SHORT_STATUSES = new Set(['FT', 'AET', 'PEN'])

/**
 * The normalized fixtures from one raw /fixtures response — split out of fetchFixturesForDate so a
 * cached payload can be re-normalized later without a second request (see
 * AppSettings.sportsFixturesCache). Pure: the same payload always yields the same list.
 */
export function normalizeFixturesFromPayload(payload: unknown): ApiFootballFixture[] {
  const typed = payload as { response?: RawFixture[] } | null
  const list = Array.isArray(typed?.response) ? typed.response : []
  return list.map(normalizeFixture)
}

export function normalizeFixture(raw: RawFixture): ApiFootballFixture {
  const kickoff = raw.fixture?.date ? new Date(raw.fixture.date) : null
  return {
    id: raw.fixture?.id ?? 0,
    kickoff: kickoff && !Number.isNaN(kickoff.getTime()) ? kickoff : null,
    league: raw.league?.name ?? '',
    country: raw.league?.country ?? '',
    round: raw.league?.round ?? '',
    homeTeam: raw.teams?.home?.name ?? 'Home',
    awayTeam: raw.teams?.away?.name ?? 'Away',
    homeGoals: raw.goals?.home ?? null,
    awayGoals: raw.goals?.away ?? null,
    live: LIVE_SHORT_STATUSES.has(raw.fixture?.status?.short ?? ''),
    finished: FINISHED_SHORT_STATUSES.has(raw.fixture?.status?.short ?? ''),
    statusLong: raw.fixture?.status?.long ?? ''
  }
}

export interface FixtureFetchResult {
  fixtures: ApiFootballFixture[]
  // Null when the fetch succeeded or was skipped by design (no key). A non-null error never
  // blocks the rest of the Sports tab — the provider schedule stays usable underneath.
  error: string | null
  // The raw response this result was normalized from — present on a successful fetch only, so a
  // caller can cache it (see AppSettings.sportsFixturesCache) and re-normalize it later instead of
  // requesting the same fixed day again.
  payload?: unknown
}

/** yyyy-mm-dd in local time — the /fixtures?date= parameter format api-football expects. Also the
 * key one day's fixtures are cached under (see AppSettings.sportsFixturesCache). */
export function fixtureDateParam(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Fetch one day's fixtures. `key` empty means the feature is unconfigured: returns an empty
 * list with no error, which is the caller's cue to stay on the provider schedule alone.
 */
export async function fetchFixturesForDate(
  fetchBridge: (path: string, key: string) => Promise<unknown>,
  key: string,
  date: Date
): Promise<FixtureFetchResult> {
  if (!key) return { fixtures: [], error: null }
  try {
    const payload = (await fetchBridge(`/fixtures?date=${fixtureDateParam(date)}`, key)) as {
      response?: RawFixture[]
      errors?: unknown
    }
    // api-football reports plan/key problems inside a 200 with an `errors` object rather than
    // a failing status code — surface that instead of silently rendering nothing.
    if (payload?.errors && !Array.isArray(payload.errors) && Object.keys(payload.errors).length > 0) {
      return { fixtures: [], error: `api-football: ${JSON.stringify(payload.errors)}` }
    }
    // The raw payload rides along so a caller can cache it verbatim (see
    // AppSettings.sportsFixturesCache) — the normalized form holds Date objects, which would not
    // survive a round trip through settings.
    return { fixtures: normalizeFixturesFromPayload(payload), error: null, payload }
  } catch (err) {
    // Electron wraps any IPC handler throw as "Error invoking remote method 'x': Error: …" —
    // strip that plumbing so the user sees the actual failure ("API-Football request failed (403)").
    const raw = err instanceof Error ? err.message : String(err)
    return { fixtures: [], error: raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }
  }
}
