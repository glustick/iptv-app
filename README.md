# IPTV

A desktop IPTV client (Electron + React) for Xtream Codes providers, with live TV, movies, series, and an EPG guide.

## Features

- Connect to any Xtream Codes panel with server URL, username, and password
- Save multiple provider profiles locally
- Browse Live TV, Movies, and Series by category, with search
- Clicking a live channel opens a preview first — current programme, progress bar, and a "coming up" list, all in your local timezone — before jumping into fullscreen playback
- Series browsing fetches seasons/episodes via `get_series_info` for playback
- Built-in player using [hls.js](https://github.com/video-dev/hls.js) for live `.m3u8` streams (with auto-recovery on network/media errors and a generous buffer to smooth out flaky connections), native `<video>` fallback for VOD/series files
- A local reverse proxy in the Electron main process works around the fact that Xtream panels don't send CORS headers, and uses Electron's own `net` module (not Node's) so it also respects your OS's certificate trust store — important on networks with a TLS-inspecting corporate proxy

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

## Project structure

```
src/
  main/           Electron main process (window creation, credential storage via electron-store, CORS-proxy)
  preload/        contextBridge API exposed to the renderer
  renderer/       React app
    src/lib/      Xtream Codes API client (xtream.ts) and XMLTV EPG parser (epg.ts)
    src/store/    Zustand store wiring auth, categories, content lists, EPG, and playback
    src/components/  UI: login, top bar, sidebar, channel/movie/series list, player, channel preview, series modal
```

## How the Xtream integration works

- **Auth & catalog**: `player_api.php` with `username`/`password` and an `action` (e.g. `get_live_categories`, `get_live_streams`, `get_vod_streams`, `get_series`, `get_series_info`) — see [`xtream.ts`](src/renderer/src/lib/xtream.ts).
- **EPG**: the channel preview uses `get_short_epg`, queried per-channel by stream ID — this is part of the core Xtream API and works even on providers that restrict the full guide (many resellers disable `xmltv.php` entirely; this app's own test account returns a 403 on it). The full XMLTV guide is still fetched as a best-effort bonus for the channel list's inline "now playing" label ([`epg.ts`](src/renderer/src/lib/epg.ts)), but its failure is silent since it's not load-bearing for the app to work.
- **Playback URLs**: built as `{server}/{live|movie|series}/{username}/{password}/{stream_id}.{ext}`, per the Xtream Codes convention.
- **CORS proxy**: Xtream panels are built for native players (VLC, set-top boxes) and never send CORS headers, so the renderer can't talk to them directly. The main process runs a small reverse proxy ([`src/main/index.ts`](src/main/index.ts)) that re-issues every request via Electron's `net` module (Chromium's network stack, honoring the OS certificate trust store) and stamps the response with permissive CORS headers.

Credentials are stored locally via `electron-store` (a JSON file in the app's user-data directory) — nothing is sent anywhere except the Xtream server you configure.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for recommended future enhancements (performance, playback quality, EPG, content/UX, packaging, and testing).
