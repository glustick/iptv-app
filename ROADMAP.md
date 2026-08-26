# Roadmap

Recommended enhancements for future development, roughly ordered by priority within each section. Grouped by theme rather than a strict backlog — pick based on what matters most to whoever picks this up next.

## Performance (do these first)

- **Virtualize the channel list.** Large providers can return tens of thousands of live channels (a real account tested during development had 24,251), and `ChannelList` currently renders every item as a DOM node. This will visibly jank on scroll for big catalogs. Switch to a windowed list (e.g. `react-window` / `react-virtuoso`) so only visible rows are mounted.
- **Debounce search input.** `setSearchTerm` re-filters on every keystroke against the full in-memory list; fine today, but worth debouncing once virtualization is in place and lists get even larger.

## Playback quality

- **Transcode AC-3/E-AC-3 audio.** Chromium has no built-in decoder for Dolby Digital audio, which a meaningful share of real IPTV/broadcast-origin channels use — video plays fine, audio doesn't (the app now detects and reports this, see `Player.tsx`, but doesn't fix it). Bundling `ffmpeg-static` and remuxing/transcoding the audio track to AAC in the local proxy (`src/main/index.ts`) would fix this properly instead of just surfacing the error.
- **DVR / catch-up (timeshift).** Xtream's `get_live_streams` response includes `tv_archive` and `tv_archive_duration` per channel — channels with archive support can serve past programming via a `/timeshift/...` URL pattern. Add a way to browse a channel's recent EPG and play back a past slot, not just live.
- **Picture-in-picture / mini-player.** The player is currently a hard fullscreen overlay (`Player.tsx`); a floating mini-player would let people keep browsing while watching.
- **Auto-reconnect on network loss.** No detection today for "the whole connection dropped" vs. "this one stream failed" — worth distinguishing and retrying the session-level connection (not just the current fragment) after sustained network loss.

## EPG

- **Full grid guide for providers that support it.** The per-channel preview (`ChannelPreview.tsx`, via `get_short_epg`) works everywhere, but some providers do serve a working `xmltv.php` (this one 403s — see `useAppStore.loadEpg`). For those, a proper multi-channel timeline grid (rows = channels, columns = time) would be a much richer guide experience than the current single-channel preview.
- **EPG-based search/browse** ("what's on now across all channels", "search programme titles") once a full guide is available for a given provider.

## Content & UX

- **Favorites and recently-watched.** Persist via the existing `electron-store`-backed storage layer (`lib/storage.ts`); surface as a pinned section or dedicated tab.
- **Series watch progress.** Track per-episode position/completion so `SeriesModal` can show progress and offer "resume" instead of always starting from the top.
- **Quick profile switching.** Today, switching providers means disconnecting and re-picking from `LoginScreen`; a lightweight dropdown in `TopBar` would be more convenient for anyone juggling multiple Xtream accounts.
- **Parental controls.** Category-based filtering or a PIN lock on adult categories — a fairly standard expectation for IPTV apps.
- **Keyboard/remote navigation.** Arrow-key channel browsing and media-key play/pause/volume support, for anyone driving this from a couch/remote setup rather than mouse + keyboard.
- **Raw M3U + separate EPG XML URL support.** Some providers hand out an M3U playlist URL and an EPG XML URL instead of full Xtream Codes API credentials — supporting that as an alternate connection type would widen compatibility beyond Xtream-specific panels.

## Packaging & distribution

- **App icon.** Currently ships with Electron's default icon (`electron-builder` logs "default Electron icon is used" during every build) — add real `build/icon.{icns,ico,png}` assets.
- **Code signing & notarization.** Unsigned installers trigger Gatekeeper warnings on macOS and SmartScreen warnings on Windows. Worth adding once a signing certificate is available — plug into the existing `.github/workflows/release.yml`.
- **Auto-update.** Since CI already publishes builds to GitHub Releases, wiring up `electron-updater` to check those releases and update in the background is a natural, low-effort next step.
- **Settings page.** Surface things that are currently hardcoded: HLS buffer size/quality preferences, EPG timezone override, light/dark theme.

## Quality

- **Automated tests.** There are none today. Given how many subtle, provider-specific issues surfaced only through manual testing against a real account (CORS, TLS trust, header forwarding, content-encoding, EPG endpoint availability — see commit history), unit tests for `lib/xtream.ts` and `lib/epg.ts`, plus a basic smoke test for the Electron main process, would catch regressions early.
