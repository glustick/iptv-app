/**
 * How this platform gets its updates — and what the UI should therefore offer.
 *
 * Background, because the reason is a decision rather than a technical accident: the app is not
 * code-signed on either platform (see ROADMAP's "Decided, not pending" — yearly cost, single-user
 * app, and a sibling browser project that covers the cert-free case). **Windows updates itself
 * flawlessly unsigned** (electron-updater has no publisher name to check against), which the
 * maintainer confirmed on 2026-09-22: "it will download, update and restart with no issue".
 * **macOS does not**: the updater can still *find* and *download* a release there, but macOS refuses
 * to apply one to an unsigned app, so the old flow ended in an error *after* the user had said yes
 * — the single user-visible cost of skipping certificates.
 *
 * Hence two modes. The point of this module is that the difference is decided in one pure, tested
 * place rather than by scattering `process.platform` checks through the UI.
 *
 * Pure and dependency-free by design — it is exactly the sort of logic STATE.md's "Direction" note
 * says should stay portable to the sibling web project.
 */

/** Where a user is sent to fetch a build by hand. */
export const RELEASES_URL = 'https://github.com/glustick/iptv-app/releases'

export type UpdateMode = 'auto' | 'manual'

/**
 * `darwin` is the only platform that cannot apply an unsigned update. Everything else keeps the
 * in-app updater — including Linux, which applies its own updates like Windows does.
 */
export function updateModeForPlatform(platform: string | null | undefined): UpdateMode {
  return platform === 'darwin' ? 'manual' : 'auto'
}

/**
 * The exact URL to send a user to for a given version: the release's own page when the version is
 * known, so they land on the right build rather than the list. Falls back to the releases list when
 * it is not (or when the version looks wrong), which is still a usable page.
 */
export function downloadPageUrl(version: string | null | undefined): string {
  const trimmed = (version ?? '').trim()
  // Tags are `vX.Y.Z`; anything else is not a version this app published and is not worth guessing
  // a URL from.
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(trimmed)) return RELEASES_URL
  return `${RELEASES_URL}/tag/v${trimmed}`
}
