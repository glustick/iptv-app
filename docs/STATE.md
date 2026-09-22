# Project state

_A consolidated handover snapshot, first written 2026-09-14 at v0.7.74 and updated 2026-09-22 at
v0.7.101. `ROADMAP.md` remains the authoritative, per-release history — this page is the "where are
we and why" summary for whoever picks this up next (human or agent)._

## TL;DR

AllisonIPTV is a working desktop IPTV client (Electron + React + TypeScript) in daily use against a
real Xtream provider with a ~30k-channel catalog. Current release: **v0.7.101** (see ROADMAP for the
full history). Test suite: **394 passing**. CI (typecheck/lint/test/build) and the three-platform
Release workflow are both green on every tagged release.

0.7.65 → 0.7.79 were almost entirely about the **EPG system**, **user-made categories**, and the
**release pipeline**; all three are now in a genuinely complete state for the provider in use.

## The EPG system, end to end

This is the part with the most moving pieces, so it's worth understanding as a whole:

1. **Sources** — the provider's own `xmltv.php` guide (when not blocked, which most resellers do) plus
   any number of user-added third-party XMLTV URLs (Guide & EPG, its own surface since 0.7.92 — formerly rolled into Settings). `loadEpgSources`
   fetches them through the local proxy, transparently handling gzip (`.xml.gz`) bodies. A monotonic
   run token means only the newest load may commit, so adding/removing a source mid-download can't
   resurrect stale state. Every configured source is accounted for in the report — loaded sources
   with match counts, failed ones with their exact reason.
2. **Matching** (`lib/epg.ts`, `matchXmltvChannels` / `buildGuideIndex` / `resolveStreamToGuide`) —
   one tier ladder, used by both the store and the Settings editor: **manual mapping → EPG id →
   exact normalized name → relaxed match**. The relaxed tier folds diacritics, unifies `&`/`and`,
   drops noise tokens (HD/FHD/4K/HEVC/VIP/backup/UK/US, standalone numbers) and sorts tokens, so
   `101 BBC One HD` joins `BBC One`. A match with zero programmes is *not* resolved data.
3. **Manual mapping** — per-source, per-channel overrides, persisted in
   `settings.epgChannelMappings`, instant to apply. Since 0.7.101 they are made one channel at a
   time from the channel row's right-click menu → **EPG match…** (`ChannelMatchModal.tsx`): the panel
   shows what the channel has now (its supplying source, and any existing mapping), lets the source
   be chosen, and lists **scored** candidates — strong ones first, weaker ones labelled with their
   percentage and marked "possible" — with that source's whole guide behind a "show all N guide
   channels" expander. It replaced a two-pane editor that lived on the guide page, which is now a
   **summary**: one row per source carrying its guide size, matched count, manual count, priority
   arrows, the full breakdown behind a disclosure, and a **Hide guide / Show guide** switch.
4. **Finding the residue** — ranked suggestion chips (Dice similarity over the same loose tokens,
   floor 0.6 by default so "BBC One" won't suggest "BBC Two"; the match panel deliberately asks for a
   lower floor, because a person choosing from labelled scores may accept what an automatic join must
   refuse) plus per-source unmatched counts in each source row's expanded breakdown.
5. **Consumption** — the pool prefills each channel's short-EPG cache; the provider's own
   per-channel `get_short_epg` merges over it (provider entries win their slots, pool data fills
   later days). The winning source per channel is recorded (`epgSourceByStream`) and shown in the
   channel preview as `Guide: <source>`.
6. **Bulk resolution** — the guide page's "Apply across all sources at _% or better" turns the
   residue into ordinary manual mappings in one action (never overwriting an existing mapping, one per
   channel, thresholds 60-100%), and the ⬆⬇ arrows on each source row set the priority order that
   decides which source wins an overlapping channel. A **Hide guide** switch takes a source out of
   the pool without deleting it (`settings.hiddenEpgSourceUrls`): its URL, priority position and
   manual mappings all survive, and the report describes it as hidden rather than as one that failed.

## Other features worth knowing about

- **My Categories** (`CustomCategoriesModal.tsx`, `lib/customCategories.ts`) — user-made groupings
  pinned at the top of the sidebar, for **Live TV, Movies and Series** (`kind` on the model; an
  absent kind means live, so pre-0.7.78 categories still load). Filled by search, the categories
  themselves and the items inside them both reorder by drag-and-drop or ⬆⬇, and everything
  persists in `settings.customCategories`. Ids are provider-scoped: unresolved ones are skipped for
  display but retained in the stored order, so a category comes back intact on reconnecting that
  provider.
- **Playback fallbacks** — `transcodeService.ts` remuxes unsupported audio (EC-3/AC-3) to AAC via
  the bundled ffmpeg, mapping one text-based subtitle stream as a WebVTT rendition with a
  hand-written master playlist, a grace fallback, and a bitmap-codec auto-retry.
- **Channel health** (`lib/channelHealth.ts`, `probeChannelHealth` in the store) — a live channel
  whose playlist is already *finished* (`#EXT-X-ENDLIST` on a live URL) is a clip on repeat, not a
  live feed; rows are flagged ⟳/⚠ from a lazily-probed manifest, the preview explains it in words,
  and a "Hide not live (N)" filter appears once any are found. Verdicts are per-session (cleared on
  connect/disconnect) and a transport failure records **no** verdict at all, so a network blip can
  never brand a channel.
- **VPN** — OpenVPN profiles (requires OpenVPN installed), split-tunnel to the provider only,
  orphaned-session recovery on launch. The tunnel routes **every** address the provider host
  resolves to (not just the first — see `main/vpnRouteScript.ts`), and because adding a route to a
  *running* tunnel needs root, a mid-session DNS change is repairable rather than automatic: the
  stream-route warning offers a "Reconnect VPN" button that rebuilds the routes against the current
  answer.
- **Auto-update** — electron-updater against GitHub Releases, with an in-app prompt that now shows
  the release's own notes (generated from ROADMAP.md into the update feed at build time — see
  `scripts/extract-release-notes.mjs` and `lib/releaseNotes.ts`).

## Release & CI/CD

- Push `main` → **CI** workflow (Node 22: typecheck, lint, test, build).
- Push a `v*` tag → **Release** workflow: three explicit jobs (mac / windows / linux), each building
  and publishing installers + update feeds to the GitHub Release, then a fourth `notes` job that
  fills the release body from this version's ROADMAP entry (`scripts/extract-release-notes.mjs`,
  which also feeds the in-app update prompt via the update feed's `releaseNotes`).
- **Code signing is wired and dormant, and staying that way**: the maintainer decided against
  buying certificates on 2026-09-22 (cost; single-user app; the test machine is Windows, where
  unsigned updates work) — see ROADMAP's "Decided, not pending". Practically: macOS never
  auto-updates and its builds are installed by hand.
- **How the wiring works**: each job checks for its own certificate secret at job level
  (`MAC_SIGNING_READY` / `WIN_SIGNING_READY`) and applies signing envs only on the signed step.
  Required secrets, documented in the README: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.
  **Trap to remember**: `CSC_LINK` must never be defined-but-empty — electron-builder's
  `getCscLink()` treats an empty value as a supplied certificate path and fails opening `''`
  (that broke macOS + Windows on v0.7.72; Linux was unaffected).
- `build/entitlements.mac.plist` carries the hardened-runtime entitlements Electron and the bundled
  ffmpeg need (JIT, unsigned executable memory, library validation off).

## Conventions

- Every release gets a detailed `ROADMAP.md` entry — including honest corrections when an earlier
  entry was wrong, and explicit "not verified" notes.
- Tests are vitest. Mostly logic-level: the store's own control flow is covered via
  prototype-level spies on the client classes, and `window.api` is stubbed per-test. A few
  **component-rendering tests** also exist (`.test.tsx`, jsdom via a per-file
  `// @vitest-environment jsdom` docblock) — **required setup**: vitest here runs on the
  oxc/rolldown flavour of Vite, where JSX is not transformed unless `oxc: { jsx: 'automatic' }` is
  set in `vitest.config.mts` (the React plugin does not cover it). Without that, any component
  import fails at transform time. Also: **keep jsdom's Node engine range compatible with CI's Node 20**
  — jsdom 30 requires Node >= 22.22 and broke a CI run while passing locally on Node 24 (pinned to
  jsdom 25 for exactly this reason).
- Overlay/Escape behaviour is decided by the pure `resolveEscapeAction` in `lib/overlays.ts`, with
  the priority order pinned by tests — add new overlays to that chain, not to App.tsx.
- **A scale guard exists** (`lib/epgScale.test.ts`): the real matching code over a synthetic
  27.8k-channel catalogue against a 5k-channel guide, with timing budgets. It immediately found that
  the bulk-suggestion planner took ~5–6s at that size and ran synchronously from the UI (fixed in
  0.7.88 by chunking the run and yielding between chunks) — the argument for keeping it.
- **A GUI smoke harness exists** (`npm run smoke:gui` → `scripts/gui-smoke.mjs`): it launches the app
  over CDP, connects with the saved profile, and asserts against the DOM (permission-free, since
  screen capture is TCC-blocked here). Use `--probe`, `--probe-settings` or `--eval "<expr>"` to
  inspect the live UI. Requires the mock provider (`node scripts/mock-provider.mjs`). It found the
  prefill-ordering bug fixed in 0.7.86 — the argument for running it after any EPG/UI change — and
  passes 19/19 against the released build, covering: connect via the saved profile, the
  sidebar and grid rendering the mock's catalogue, the provider's per-channel listing winning its
  slot, a relaxed-tier-matched channel being filled from the guide pool, an unmatched channel
  honestly reporting "No programme data", the preview's provenance line, the EPG match report's
  per-tier counts, and the overlay chain (Settings closes, the manager opens, Escape closes the
  outermost layer), and — with the fixture's optional playable-media support (it generates a small
  HLS stream with ffmpeg when given `ffmpegPath`, served at the Xtream `/live/<user>/<pass>/<id>.m3u8`
  path) — **that playback really decodes and advances**, which is the one thing an Electron/Chromium
  upgrade can break while every other check still passes. Two lessons baked into it: assertions must POLL (the guide pool arrives only
  after a multi-megabyte download, so single-shot checks report flakiness), and overlays must be
  addressed by their own containers (`.settings-card .modal-close`, not `.modal-close`, which the
  preview panel also carries); and a page can hold more than one `<video>` (the preview panel has
  its own), so playback assertions ask whether ANY of them is decoding rather than trusting the
  first one found; and quit the app with a BOUNDED graceful attempt followed by a forced kill —
  AppleScript's `quit` blocks forever when the app has a modal open (an update prompt did exactly
  that and hung a whole run). The fixture also produces an E-AC-3 ("Dolby") variant for one
  channel, so the audio-fix fallback is covered too.
- **A synthetic Xtream provider exists** (`lib/testFixtures/mockXtreamServer.ts`, serving the
  `player_api.php`/`xmltv.php`/`__fetch` subset the app uses) and `lib/xtreamIntegration.test.ts`
  drives the real client and store against it over a real socket with nothing mocked — that is the
  place to verify EPG pipeline behaviour without the real provider. Still missing: driving the GUI
  itself (needs the app launched + CDP) and playable stream fixtures for playback tests — and note
- **The dev Electron runtime is non-functional on this machine (measured 2026-09-16).** Three
  separate problems, worth knowing as three: (1) `node_modules/electron/path.txt` was missing, so the
  `electron` CLI could not even resolve its binary — the npm postinstall that writes it never completed
  here, which is why `npm run dev` has never worked on this Mac; (2) launching the binary is SIGKILLed
  instantly, with no crash report, equally outside the tool sandbox (verified via the gateway host), and
  **macOS raises a "malware blocked" dialog** for it — so this is a real AV/XProtect block on the dev
  runtime, not a signature or quarantine problem (re-signing produced a valid signature and changed
  nothing); (3) the local `dist/Electron.app` is a gutted stub (~252K, MacOS + a few lproj dirs) rather
  than a full ~200MB app, so it cannot be launched even if it were allowed. Net effect: the app is built
  on this machine but can only be *run* elsewhere, and **no GUI-automation plan can be validated here** —
  a CDP harness would have to run where the app starts. It also does not matter operationally: tests,
  typecheck, lint and `electron-vite build` need no Electron runtime, and CI does a clean `npm install`.
  **Do not "fix" a vendored Electron by re-signing it** — an earlier attempt at exactly that is the most
  likely trigger for the malware dialog, and modifying a third-party binary inside `node_modules` is the
  wrong move regardless (the pristine copy and the manifests were restored; the repo itself was never
  changed by it). Resolution in place (2026-09-16): the `electron` *package* stays installed (its
  `electron.d.ts` is what `src/main` and `src/preload` typecheck against — removing the package
  breaks `npm run typecheck`), but its **`dist/` bundle is deliberately absent**, so there is no
  Electron binary on disk and nothing for the AV to act on. `npm run dev` fails accordingly (it never
  worked here); tests, typecheck, lint and `electron-vite build` are unaffected. A plain
  `npm install` on this machine will re-download the binary and may trip the same dialog — if that
  happens, delete `node_modules/electron/dist` again rather than touching any security setting.
- **RESOLVED in 0.7.85 (measured 2026-09-16): the app RUNS on this Mac.** The Electron 44.4.1 build
  (v0.7.85) was downloaded and opened normally — main process, GPU and network-service helpers all up,
  bundle intact, `~/Library/Application Support/iptv-app` created. The earlier blocks were therefore
  tied to the old Electron (31.7.7), not to "unsigned code" as such: that framework's binary is what
  macOS objected to (XProtect flags files, not apps), both for the dev runtime and inside the packaged
  0.7.84 build. Signing + notarization is still required for *distribution* (Gatekeeper warnings for
  other users, working macOS auto-update, and browser-downloaded copies which carry a quarantine flag)
  — but it is no longer needed merely to run the app locally.
- **Historical record — the pre-0.7.85 block (2026-09-16 morning).** Downloaded the
  released `AllisonIPTV-0.7.84-arm64-mac.zip` from GitHub and opened it: a complete 312 MB bundle,
  **no quarantine attribute**, but `codesign` shows ad-hoc/linker-signed with `TeamIdentifier not set`
  (unsigned and, of course, unnotarized). `spctl` refuses it, the process never appears, and macOS's
  malware remediation **moved `AllisonIPTV.app` to the Trash** while showing the same "malware blocked"
  dialog as for the dev Electron — same class of block, same cause: untrusted unsigned code. No MDM or
  EDR is involved (this Mac is not enrolled; the Defender shim present in /Applications is not running).
  So: **running this app locally is gated on code signing + notarization**, which the 0.7.72/0.7.73
  pipeline already implements and which activates the moment the seven secrets exist. Until then the app
  runs only on a machine that tolerates unsigned builds (the Windows box), and any local GUI work
  (including a CDP harness) is blocked for the same reason. Do not attempt to allow-list or override
  this: macOS offers **no per-app exception** for a malware-class detection (XProtect is YARA-rule
  based and non-overridable, and Gatekeeper's "Open Anyway" does not apply since the download carried
  no quarantine flag). The realistic options are: (a) **run it where unsigned builds are tolerated**
  (the Windows box) — free, and what happens today; (b) **sign + notarize** — the only route that
  makes it run here *and* fixes it for every macOS user, at the cost of an Apple Developer account;
  (c) **find the flagged file and replace it** — XProtect flags files, not apps, and this bundle
  carries two classic false-positive magnets (the Electron 31.7.7 framework, and ffmpeg-static's
  ffmpeg binary), so if the detection names one of those, upgrading/replacing that component is free
  (and bumping Electron is good hygiene anyway) — needs the dialog's exact wording or
  `sudo log show --last 2h --predicate 'eventMessage CONTAINS "Detected"'` to confirm; (d) **run the
  published AppImage in a Linux VM**, which sidesteps macOS code-signing entirely without weakening
  anything. Do not disable or weaken system protections for this.
- Destructive or irreversible actions ask first (`window.confirm`), and are called out in code
  comments with the reasoning.

## Direction: parity with the web sibling, and the door to a merge

There are two IPTV applications in this environment: **this Electron one, and a browser-based
sibling** started specifically because a web app needs no code-signing certificate from Apple or
Microsoft (see ROADMAP's "Decided, not pending"). The maintainer's stated hope is **parity between
them, and possibly a merge one day** — with an important caveat he has already observed himself:
*"the fat application seems to have a lot better options to play video than in a web browser"*.

That observation is structural, not incidental, and it shapes what parity can mean:

| Capability | Here (Electron) | In a browser |
| --- | --- | --- |
| Local proxy in front of the provider | Yes — no CORS/mixed-content limits, own headers, transparent gzip | No — the browser's own request rules apply |
| A real ffmpeg | Bundled: the audio-fix remux and text-subtitle conversion depend on it | None — no transcoding/remuxing at all |
| VPN / split-tunnel control | Yes — it owns the tunnel and the routes | No — it cannot touch the OS |
| Background throttling | Never — the window keeps decoding when unfocused | Tabs are throttled; playback stalls when backgrounded |
| Window/fullscreen/keep-awake | Native control | Whatever the browser allows |
| Codec fallbacks | Can remux or swap streams on the fly | Whatever the browser can decode, full stop |

So: **a full merge cannot give the browser those things** — the honest goal is parity *at the logic
layer* plus a shared UI, with the native capabilities kept behind an interface the browser target
stubs out. That is the shape a merge would actually take (one codebase, two targets), and the seed of
it already exists: the two projects trade findings through handoff notes, and the pure modules here —
`epg.ts`, `epgTime.ts`, `channelHealth.ts`, `channelMatch.ts`, `playbackWatchdog.ts`, `hlsLevels.ts`,
`iptvClient.ts`, `m3u.ts`/`m3uClient.ts`, `reminders.ts`, `overlays.ts` — have no Electron or DOM
dependency (the hooks wrapping them do). **The cheap discipline that keeps the option open: keep new
pure logic free of `window`, `document` and Electron imports, and put the platform bits in hooks or
services.** No work is scheduled for this; it is recorded so the choice stays available.

## What's next (all of it needs a human's resources)

| Item | Needs |
| --- | --- |
| Make the macOS update prompt say "download the .dmg" instead of failing | ~an hour, no external resources |
| VPN verification (routing, split-tunnel, unreachable-after-failure) | A live Windows session |
| Linux packaged window-icon check | Real Linux hardware |
| Proxy stuck-connection root cause | A live repro + `chrome://net-export` capture |
| Single-connection audio-fix fallback conflict | A controlled live repro (testing was deliberately stopped to avoid locking the account) |
| "Channel is currently broken" surface | Frequency data: how often channels are genuinely dead |
| Manual quality-level selection | A provider that serves multi-variant streams (the current one serves one flat rendition) |
| Windows ARM installer | An arm64 ffmpeg binary to bundle (`ffmpeg-static` ships none) |

## Known rough edges

- **The manual pass is now real, but partial.** The user has run several sessions against the real
  provider (on **Windows** — see below), which is where 0.7.98–0.7.101's fixes came from: the
  fullscreen trap, the guide hang, the Multi-View picker and the per-channel matching flow were all
  reported by hand. What has still never been clicked through in a running window: My Categories
  drag-and-drop, the bulk-apply button, the preview's guide-source line, and the update prompt's
  notes. Windows itself is never tested by the maintainer's machine — CI builds it, the user runs it.
- **The guide load is the known self-inflicted hang** (107MB of XML parsed synchronously; see the
  roadmap's Next up). Until it is reworked, opening the Guide & EPG page on this provider can freeze
  the window for seconds and is the prime suspect for the blank-screen death reported on 2026-09-22.
- `docs/` dates from 2026-09-14.

## Resolved 2026-09-16: VOD subtitle rendition never reached playback

**Cause: `transcodeService`'s own `exit` handler.** It deleted the session *and its directory* the
instant ffmpeg exited. For VOD/series, ffmpeg exiting is the normal end of a *successful* transcode —
the finished file is the deliverable — so the output was destroyed while playback still needed it.
And because the readiness loop polls concurrently, the directory could be removed before the loop had
ever observed the playlist, which is why 0.7.90's disk re-check changed nothing: by then the disk had
been wiped.

**Fixed in 0.7.91**: sessions that produced a playlist are kept and retired by the same stop/quit
paths as before; sessions that produced nothing are still cleaned up immediately (genuine failure to
start).

**Verified**: smoke harness 29/29, including `choosing a subtitle ends in a real subtitle rendition on
the playing element`, and `ffmpeg exited before producing output` in the app log went from 3
occurrences per run to 0. The E-AC-3 assertion was strengthened at the same time — decoding alone is
satisfied by the *original* stream, whose video decodes fine while its audio produces nothing — so it
now also asserts the player actually fetched from `/__transcode/`.

**Also fixed in 0.7.91**: the player's two subtitle dropdowns were labelled identically while doing
different things (hls.js renditions = instant; the ffmpeg-level picker = restarts the transcode). They
are now "Subtitle track" vs "Subtitles".

**Harness lesson (was a real flake, not an app bug):** the VOD grid is virtualised and renders only
once its container has a measured size. An occluded window defers that layout, which produced an empty
grid with no error and a *correct* listing — and made the same build pass or fail run to run. The
harness now activates the app before that section and reports the grid's measured box, which read
`1060x718` on the passing run.
