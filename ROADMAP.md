# Roadmap

Recommended enhancements for future development, roughly ordered by priority within each section. Grouped by theme rather than a strict backlog — pick based on what matters most to whoever picks this up next.

**Status:** the "Content & UX", "Playback" partial items, and "Quality" sections below were implemented in the 0.2.0 release (favorites, series progress, quick profile switching, parental controls, keyboard shortcuts for the player, DVR/catch-up, auto-reconnect, real Picture-in-Picture, a settings page, virtualized lists, debounced search, an app icon, `electron-updater` wiring, and a first pass of automated tests). What's below is what's left, plus a few things the 0.2.0 build surfaced as worth doing next.

## Quick wins

- **Surface recently-watched in the UI.** The data already flows end-to-end (`useAppStore.play()` persists every play to `recentlyWatched` via `lib/storage.ts`), but nothing renders it yet — it's tracked and immediately forgotten. Wiring up a "Continue watching" section (e.g. in the Favorites tab, or a new one) is most of the way done already.
- **Channel-list keyboard navigation.** The player has keyboard shortcuts (Escape/M/arrows) but the channel list itself doesn't — arrow keys to move focus between channels/tiles and Enter to open, useful for anyone driving this without a mouse (remote, couch setup). Needs a focused-index concept that plays well with the virtualized list's `scrollToRow`/`scrollToCell` imperative API (already exposed by `react-window`, just not used yet).
- **Fix the cross-section locked-category edge case.** Parental-lock category IDs are stored as a flat list shared across Live/Movies/Series (`settings.lockedCategoryIds`). Xtream doesn't guarantee `category_id` is globally unique across those three sections, so in a rare case a provider could reuse the same ID in two sections and locking one would also lock the other. Namespacing the stored ID by section (e.g. `"live:12"` vs `"movies:12"`) closes this.

## Playback quality

- **Transcode AC-3/E-AC-3 audio.** Still the biggest real gap. Chromium has no built-in decoder for Dolby Digital audio, which a meaningful share of real IPTV/broadcast-origin channels use — video plays fine, audio doesn't. The app detects and reports this now (`Player.tsx`'s `bufferAddCodecError`/`bufferAppendError` handling) but doesn't fix it. Bundling `ffmpeg-static` and remuxing/transcoding the audio track to AAC in the local proxy (`src/main/index.ts`) would fix it properly.
- **Full grid EPG guide for providers that support it.** The per-channel preview (`ChannelPreview.tsx`, via `get_short_epg`) works everywhere, but some providers do serve a working `xmltv.php` (this project's test account 403s on it — see `useAppStore.loadEpg`). For those, a proper multi-channel timeline grid (rows = channels, columns = time) — `react-window`'s `Grid` is already a dependency and would fit well here — would be a much richer guide than the current single-channel preview. Pair with EPG-based search ("what's on now across all channels", search programme titles).

## Compatibility

- **Raw M3U + separate EPG XML URL support.** Some providers hand out an M3U playlist URL and an EPG XML URL instead of full Xtream Codes API credentials. Supporting that as an alternate connection type (a second tab on `LoginScreen`, a simple M3U parser alongside `lib/xtream.ts`) would widen compatibility beyond Xtream-specific panels. Not attempted yet — no M3U source was available to test against during this pass, and it's a meaningfully different data model (no `player_api.php` categories/actions) that deserves its own real-provider validation rather than a guess.

## Packaging & distribution

- **Code signing & notarization.** Unsigned installers trigger Gatekeeper warnings on macOS and SmartScreen warnings on Windows — and macOS's Squirrel-based auto-updater specifically **won't apply updates at all** to an unsigned/unnotarized app, so this is now a hard blocker for auto-update actually working on Mac, not just a polish item. Needs a paid Apple Developer certificate and (for Windows) a code-signing certificate; plug into `.github/workflows/release.yml` once available.
- **Reconsider the parental PIN's threat model.** It's stored in plaintext in `electron-store`'s JSON file (consistent with how Xtream credentials are already stored there) — fine as a soft "don't let a kid stumble into the wrong category" lock, not fine if anyone expects it to resist a technically curious household member reading the config file. Worth a one-line disclaimer in the settings UI if nothing else; a real fix would mean OS keychain storage instead.
- **Windows on ARM installer.** CI currently builds Windows x64 only (matching `windows-latest`'s native runner arch). Niche, but electron-builder can cross-build an ARM64 NSIS installer in the same job if it's ever worth the extra CI minutes.

## Quality

- **Expand test coverage.** The 0.2.0 pass added vitest unit tests for `lib/xtream.ts` and `lib/epg.ts` — the two riskiest pieces of pure logic — plus a CI job that runs typecheck/test/build on every push. Still untested: the Zustand store's actions (`useAppStore.ts`), the parental-lock flow, and the main-process proxy (`src/main/index.ts`) itself. The proxy in particular is where most of the real-world bugs turned up during development (CORS, TLS trust, header forwarding, content-encoding) and would benefit most from a regression suite — e.g. spin up a local mock HTTP server (as was done ad hoc during manual testing) and assert on proxied responses.
