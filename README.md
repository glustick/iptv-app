# IPTV

A desktop IPTV client (Electron + React) for Xtream Codes providers, with live TV, movies, series, and an EPG guide.

## Features

- Connect to any Xtream Codes panel with server URL, username, and password
- Save multiple provider profiles locally
- Browse Live TV, Movies, and Series by category, with search
- Live channel list shows the current programme from the provider's XMLTV EPG (`xmltv.php`)
- Series browsing fetches seasons/episodes via `get_series_info` for playback
- Built-in player using [hls.js](https://github.com/video-dev/hls.js) for live `.m3u8` streams, with native `<video>` fallback for VOD/series files

## Requirements

This machine doesn't currently have Node.js installed. Install Node.js 18+ (via [nvm](https://github.com/nvm-sh/nvm) or the [official installer](https://nodejs.org/)) before continuing.

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

## Project structure

```
src/
  main/           Electron main process (window creation, credential storage via electron-store)
  preload/        contextBridge API exposed to the renderer
  renderer/       React app
    src/lib/      Xtream Codes API client (xtream.ts) and XMLTV EPG parser (epg.ts)
    src/store/    Zustand store wiring auth, categories, content lists, EPG, and playback
    src/components/  UI: login, top bar, sidebar, channel/movie/series list, player, series modal
```

## How the Xtream integration works

- **Auth & catalog**: `player_api.php` with `username`/`password` and an `action` (e.g. `get_live_categories`, `get_live_streams`, `get_vod_streams`, `get_series`, `get_series_info`) — see [`xtream.ts`](src/renderer/src/lib/xtream.ts).
- **EPG**: the full programme guide is pulled once per session from `xmltv.php` and parsed client-side ([`epg.ts`](src/renderer/src/lib/epg.ts)); per-channel "now playing" is looked up from that parsed guide by matching each stream's `epg_channel_id`. `get_short_epg` is also wired up in the client for a lighter-weight per-channel now/next lookup if you want to use it instead.
- **Playback URLs**: built as `{server}/{live|movie|series}/{username}/{password}/{stream_id}.{ext}`, per the Xtream Codes convention.

Credentials are stored locally via `electron-store` (a JSON file in the app's user-data directory) — nothing is sent anywhere except the Xtream server you configure.
