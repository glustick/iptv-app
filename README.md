# IPTV

A desktop IPTV client (Electron + React) for Xtream Codes providers, with live TV, movies, series, and an EPG guide. Also supports raw M3U playlists (live TV only) for providers that don't hand out Xtream credentials.

**[Download the latest release](../../releases/latest)** — prebuilt installers for Windows, macOS, and Linux.

## Features

- Connect to any Xtream Codes panel with server URL, username, and password — or a bare M3U playlist URL (plus an optional separate EPG XML URL) for providers that only offer that
- Save multiple provider profiles locally
- Browse Live TV, Movies, and Series by category, with search
- Clicking a live channel opens a preview first — current programme, progress bar, and a "coming up" list, all in your local timezone — before jumping into fullscreen playback
- Series browsing fetches seasons/episodes via `get_series_info` for playback
- Built-in player using [hls.js](https://github.com/video-dev/hls.js) for live `.m3u8` streams (with auto-recovery on network/media errors and a generous buffer to smooth out flaky connections), native `<video>` fallback for VOD/series files
- A local reverse proxy in the Electron main process works around the fact that Xtream panels don't send CORS headers, and uses Electron's own `net` module (not Node's) so it also respects your OS's certificate trust store — important on networks with a TLS-inspecting corporate proxy
- **EPG from multiple guide sources**: the provider's own `xmltv.php` guide (when it allows one) plus any number of user-added XMLTV URLs (plain or `.xml.gz`), pooled per channel so later days and channels the provider doesn't cover still get listings
- **Channel matching that works at scale**: guides are joined to channels by EPG id, then exact name, then a relaxed match that ignores quality tags, leading channel numbers, country prefixes and accents ("101 BBC One HD" → "BBC One"). A per-source report shows exactly what matched and how, and any channel can be mapped by hand — individually, or in bulk from ranked suggestions ("apply everything scoring 80% or better")
- **Guide priority and provenance**: sources are tried in your order of preference (provider guide first, then your sources top-to-bottom), and the channel preview shows which source is supplying that channel's listings
- **A dedicated Guide & EPG section**: guide sources, matching and manual channel maps live on their own surface (top-bar button, or the compact row inside Settings) — one card per source with its status, match counts and actions together, instead of everything packed into the general Settings dialog
- **My Categories**: your own groupings for Live TV, Movies and Series, pinned above the provider's categories, filled by search and ordered by drag-and-drop — persisted in your settings, included in backups
- **Release notes in the update prompt**: each release's notes (generated from `ROADMAP.md` at build time) appear both on the GitHub release page and in the app's own update dialog

## Requirements

Node.js 18+ (via [nvm](https://github.com/nvm-sh/nvm) or the [official installer](https://nodejs.org/)).

## Getting started

```bash
npm install
npm run dev
```

This launches the Electron app in development mode with hot reload.

## Building

```bash
npm run build        # bundle main/preload/renderer
npm run build:mac    # package a macOS app
npm run build:win    # package a Windows installer
npm run build:linux  # package a Linux AppImage
```

### Releases

Pushing a `v*` tag (e.g. `git tag v0.1.0 && git push origin v0.1.0`) triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds native installers on Windows/Mac/Linux runners and publishes them to a [GitHub Release](../../releases) automatically.

### Code signing & notarization

Signed builds are fully wired but **activate by themselves only once the repository secrets exist** — with none set, the release pipeline publishes unsigned installers exactly as before, and no workflow edit is needed to switch either way.

Add these under *Settings → Secrets and variables → Actions*:

| Secret | Platform | What it is |
| --- | --- | --- |
| `MAC_CSC_LINK` | macOS | Developer ID Application certificate, base64-encoded `.p12` |
| `MAC_CSC_KEY_PASSWORD` | macOS | Password for that `.p12` |
| `APPLE_ID` | macOS | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | macOS | Team ID from the developer account |
| `WIN_CSC_LINK` | Windows | Code-signing certificate, base64-encoded `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | Windows | Password for that `.pfx` |

To base64 a certificate: `base64 -i cert.p12 | pbcopy` (macOS) or `certutil -encode cert.pfx out.txt` (Windows).

Why it matters: without a signature, macOS Gatekeeper warns or blocks the app on first launch **and `electron-updater` cannot apply updates at all** (macOS refuses to replace an unsigned bundle), while Windows shows SmartScreen warnings. Once the secrets are in place the next tagged release is signed, notarized (see `build/entitlements.mac.plist` for the hardened-runtime entitlements Electron and the bundled ffmpeg need), and updates flow normally.

## Tests

```bash
npm test          # vitest run
npm run typecheck # tsc on both the node and web projects
npm run lint      # eslint (includes a no-floating-promises rule)
```

The suite is mostly logic-level, with two exceptions worth knowing about:

- **Component-rendering tests** live in `src/renderer/src/components/*.test.tsx` and opt into jsdom per file with a `// @vitest-environment jsdom` docblock. This project's vitest runs on the oxc/rolldown flavour of Vite, so JSX in tests requires `oxc: { jsx: 'automatic' }` in `vitest.config.mts` — without it every component import fails at transform time, and the React-plugin route does not cover it. Keep `jsdom`'s Node engine range compatible with CI's Node 20 (jsdom 30 needs Node ≥22.22; the repo pins jsdom 25 for that reason).
- **Integration tests** in `src/renderer/src/lib/xtreamIntegration.test.ts` start `testFixtures/mockXtreamServer.ts` — a dependency-free synthetic Xtream provider — and drive the *real* `XtreamClient` and the *real* store against it over a real socket, mocking nothing: auth, catalogues, short EPG, the full XMLTV guide, the custom-source `/__fetch/` path, every channel-matching tier, the match report and the EPG pool prefill. That is the place to verify pipeline behaviour without a live provider.

## Project structure

```
src/
  main/           Electron main process (window creation, credential storage via electron-store, CORS-proxy)
  preload/        contextBridge API exposed to the renderer
  renderer/       React app
    src/lib/      Xtream Codes API client (xtream.ts), M3U parser/client (m3u.ts, m3uClient.ts), the shared IptvClient interface (iptvClient.ts), the XMLTV parser and channel-matching tiers (epg.ts), custom-category helpers (customCategories.ts), the Escape/overlay priority chain (overlays.ts), release-note formatting (releaseNotes.ts)
    src/lib/testFixtures/  a synthetic Xtream provider (mockXtreamServer.ts) the integration tests drive over a real socket
    src/store/    Zustand store wiring auth, categories, content lists, EPG, and playback
    src/components/  UI: login, top bar, sidebar, channel/movie/series list, player, channel preview, EPG grid and mapping editor, My Categories manager, settings, series modal
```

## How the Xtream integration works

- **Auth & catalog**: `player_api.php` with `username`/`password` and an `action` (e.g. `get_live_categories`, `get_live_streams`, `get_vod_streams`, `get_series`, `get_series_info`) — see [`xtream.ts`](src/renderer/src/lib/xtream.ts).
- **EPG**: the channel preview uses `get_short_epg`, queried per-channel by stream ID — this is part of the core Xtream API and works even on providers that restrict the full guide (many resellers disable `xmltv.php` entirely; this app's own test account returns a 403 on it). The full XMLTV guide is still fetched as a best-effort bonus for the channel list's inline "now playing" label ([`epg.ts`](src/renderer/src/lib/epg.ts)), but its failure is silent since it's not load-bearing for the app to work.
- **Playback URLs**: built as `{server}/{live|movie|series}/{username}/{password}/{stream_id}.{ext}`, per the Xtream Codes convention.
- **CORS proxy**: Xtream panels are built for native players (VLC, set-top boxes) and never send CORS headers, so the renderer can't talk to them directly. The main process runs a small reverse proxy ([`src/main/index.ts`](src/main/index.ts)) that re-issues every request via Electron's `net` module (Chromium's network stack, honoring the OS certificate trust store) and stamps the response with permissive CORS headers.

Credentials are stored locally via `electron-store` (a JSON file in the app's user-data directory) — nothing is sent anywhere except the Xtream server you configure.

## How the M3U integration works

For providers that only offer a bare playlist: `m3u.ts` parses the extended-M3U format (`#EXTINF` lines' `tvg-id`/`tvg-logo`/`group-title` attributes, plus `#EXTM3U`'s own `url-tvg`/`x-tvg-url` for EPG auto-discovery), and `m3uClient.ts` implements the same [`IptvClient`](src/renderer/src/lib/iptvClient.ts) interface `XtreamClient` does, so the rest of the app (store, EPG grid, player) never needs to know which backend a given profile actually came from. It's live-TV only — a flat M3U has no structured equivalent of Xtream's separate movie/series catalogs. Unlike Xtream (where every request shares one base URL the proxy resolves paths against), an M3U playlist can reference a different host per channel, so the proxy has a second route, `/__fetch/<url-encoded absolute URL>`, that proxies to any destination directly.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for recommended future enhancements (performance, playback quality, EPG, content/UX, packaging, and testing).
