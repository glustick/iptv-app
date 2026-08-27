# Roadmap

Recommended enhancements for future development, roughly ordered by priority within each section. Grouped by theme rather than a strict backlog — pick based on what matters most to whoever picks this up next.

**Status:**
- **0.2.0** shipped favorites, series progress, quick profile switching, parental controls, keyboard shortcuts for the player, DVR/catch-up, auto-reconnect, real Picture-in-Picture, a settings page, virtualized lists, debounced search, an app icon, `electron-updater` wiring, and a first pass of automated tests.
- **0.3.0** replaced the single-channel modal preview with a docked, resizable panel containing a small live video preview and a full multi-channel Gantt-style EPG grid (channels down the vertical axis, time across the horizontal axis, programmes as positioned blocks) — this also closes out the "full grid EPG guide" item that used to be listed below. The sidebar and the panel are both drag-resizable now, with widths persisted.

What's below is what's left, plus fresh findings from building 0.3.0.

## Quick wins

- **Surface recently-watched in the UI.** Still tracked end-to-end (`useAppStore.play()` persists every play to `recentlyWatched`) but still nothing renders it — carried over from the 0.2.0 roadmap, still the easiest high-value gap.
- **Programme-title search in the EPG grid.** The grid's search box currently filters by channel name only (reusing the same filter as the channel list). Extending it to also match against each row's loaded programme titles — "what's playing a movie called X right now" — would make the grid much more useful for browsing by content rather than by channel.
- **Stagger short-EPG fetches when scrolling the grid quickly.** Each row that scrolls into view fires its own `get_short_epg` call with no throttling. Fine at normal browsing speed, but flinging the scrollbar through a large category can fire a burst of parallel requests. A small per-row fetch delay or a max-in-flight queue would be a cheap safety margin against provider rate limits.
- **Channel-list keyboard navigation.** Still missing — carried over from 0.2.0. The player has shortcuts (Escape/M/arrows) but the channel list and EPG grid don't. `react-window`'s `scrollToRow`/`scrollToCell` imperative API is already available, just not wired to arrow keys/Enter yet.
- **Fix the cross-section locked-category edge case.** Still open — `settings.lockedCategoryIds` is a flat list shared across Live/Movies/Series, and Xtream doesn't guarantee `category_id` uniqueness across those three sections. Namespacing the stored ID by section (`"live:12"` vs `"movies:12"`) closes it.

## EPG grid follow-ups

- **Wider time navigation.** The grid currently shows a fixed 3-hour window shiftable by ±1 hour. `get_short_epg`'s returned item count (currently fetched at `limit=16`) bounds how far forward this can meaningfully go, and backward navigation only works as far as a given provider happens to include past entries. A "jump to date" control, or a wider default window on wide panel sizes, would make browsing further out less clicky. Worth checking per-provider how much history/future `get_short_epg` actually returns before over-building this.
- **Row density toggle.** Rows are a fixed 40px/128px-channel-column today. A compact mode (shorter rows, smaller icons) would let a wide+tall panel show meaningfully more channels at once — the panel is already resizable up to 1000px wide, but height is whatever the window gives it.

## Playback quality

- **Transcode AC-3/E-AC-3 audio.** Still the biggest real gap. Chromium has no built-in decoder for Dolby Digital audio, which a meaningful share of real IPTV/broadcast-origin channels use — video plays fine, audio doesn't. The app detects and reports this (`Player.tsx`'s `bufferAddCodecError`/`bufferAppendError` handling) but doesn't fix it. Bundling `ffmpeg-static` and remuxing/transcoding the audio track to AAC in the local proxy (`src/main/index.ts`) would fix it properly.

## Compatibility

- **Raw M3U + separate EPG XML URL support.** Some providers hand out an M3U playlist URL and an EPG XML URL instead of full Xtream Codes API credentials. Supporting that as an alternate connection type (a second tab on `LoginScreen`, a simple M3U parser alongside `lib/xtream.ts`) would widen compatibility beyond Xtream-specific panels. Not attempted yet — no M3U source was available to test against, and it's a meaningfully different data model that deserves its own real-provider validation rather than a guess.

## Packaging & distribution

- **Code signing & notarization.** Unsigned installers trigger Gatekeeper warnings on macOS and SmartScreen warnings on Windows — and macOS's Squirrel-based auto-updater specifically **won't apply updates at all** to an unsigned/unnotarized app, so this is a hard blocker for auto-update actually working on Mac, not just a polish item. Needs a paid Apple Developer certificate and (for Windows) a code-signing certificate; plug into `.github/workflows/release.yml` once available.
- **Reconsider the parental PIN's threat model.** Stored in plaintext in `electron-store`'s JSON file (consistent with how Xtream credentials are already stored there) — fine as a soft "don't let a kid stumble into the wrong category" lock, not fine if anyone expects it to resist a technically curious household member reading the config file. A real fix would mean OS keychain storage instead.
- **Windows on ARM installer.** CI currently builds Windows x64 only (matching `windows-latest`'s native runner arch). Niche, but electron-builder can cross-build an ARM64 NSIS installer in the same job if it's ever worth the extra CI minutes.

## Quality

- **Expand test coverage.** vitest unit tests exist for `lib/xtream.ts` and `lib/epg.ts`, plus a CI job that runs typecheck/test/build on every push. Still untested: the Zustand store's actions (`useAppStore.ts`), the parental-lock flow, the EPG grid's time/percent math (`EpgGridPanel.tsx`'s `pct()` and window logic), and the main-process proxy (`src/main/index.ts`) itself. The proxy is where most real-world bugs turned up during development (CORS, TLS trust, header forwarding, content-encoding) and would benefit most from a regression suite — e.g. spin up a local mock HTTP server (as was done ad hoc during manual testing) and assert on proxied responses.
