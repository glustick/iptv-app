# Project state

_A consolidated handover snapshot, first written 2026-09-14 at v0.7.74 and updated 2026-09-15 at
v0.7.79. `ROADMAP.md` remains the authoritative, per-release history — this page is the "where are
we and why" summary for whoever picks this up next (human or agent)._

## TL;DR

AllisonIPTV is a working desktop IPTV client (Electron + React + TypeScript) in daily use against a
real Xtream provider with a ~30k-channel catalog. Current release: **v0.7.79** (see ROADMAP for the
full history). Test suite: **~297 passing**. CI (typecheck/lint/test/build) and the three-platform
Release workflow are both green on every tagged release.

0.7.65 → 0.7.79 were almost entirely about the **EPG system**, **user-made categories**, and the
**release pipeline**; all three are now in a genuinely complete state for the provider in use.

## The EPG system, end to end

This is the part with the most moving pieces, so it's worth understanding as a whole:

1. **Sources** — the provider's own `xmltv.php` guide (when not blocked, which most resellers do) plus
   any number of user-added third-party XMLTV URLs (Settings ▸ EPG sources). `loadEpgSources`
   fetches them through the local proxy, transparently handling gzip (`.xml.gz`) bodies. A monotonic
   run token means only the newest load may commit, so adding/removing a source mid-download can't
   resurrect stale state. Every configured source is accounted for in the report — loaded sources
   with match counts, failed ones with their exact reason.
2. **Matching** (`lib/epg.ts`, `matchXmltvChannels` / `buildGuideIndex` / `resolveStreamToGuide`) —
   one tier ladder, used by both the store and the Settings editor: **manual mapping → EPG id →
   exact normalized name → relaxed match**. The relaxed tier folds diacritics, unifies `&`/`and`,
   drops noise tokens (HD/FHD/4K/HEVC/VIP/backup/UK/US, standalone numbers) and sorts tokens, so
   `101 BBC One HD` joins `BBC One`. A match with zero programmes is *not* resolved data.
3. **Manual mapping** — per-source, per-channel overrides created in the editor, persisted in
   `settings.epgChannelMappings`, instant to apply.
4. **Finding the residue** — the editor's "only channels with no listings from this source" filter
   (resolves the whole catalog once, from the event handler, never mid-render) plus ranked
   suggestion chips (Dice similarity over the same loose tokens, floor 0.6 so "BBC One" won't
   suggest "BBC Two").
5. **Consumption** — the pool prefills each channel's short-EPG cache; the provider's own
   per-channel `get_short_epg` merges over it (provider entries win their slots, pool data fills
   later days). The winning source per channel is recorded (`epgSourceByStream`) and shown in the
   channel preview as `Guide: <source>`.
6. **Bulk resolution** — the editor's "Apply suggestions at _% or better" turns the residue into
   ordinary manual mappings in one action (never overwriting an existing mapping, one per channel,
   threshold 60-100%), and the ⬆⬇ arrows on each source row set the priority order that decides
   which source wins an overlapping channel.

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
- **VPN** — OpenVPN profiles (requires OpenVPN installed), split-tunnel to the provider only,
  orphaned-session recovery on launch.
- **Auto-update** — electron-updater against GitHub Releases, with an in-app prompt that now shows
  the release's own notes (generated from ROADMAP.md into the update feed at build time — see
  `scripts/extract-release-notes.mjs` and `lib/releaseNotes.ts`).

## Release & CI/CD

- Push `main` → **CI** workflow (Node 20: typecheck, lint, test, build).
- Push a `v*` tag → **Release** workflow: three explicit jobs (mac / windows / linux), each building
  and publishing installers + update feeds to the GitHub Release, then a fourth `notes` job that
  fills the release body from this version's ROADMAP entry (`scripts/extract-release-notes.mjs`,
  which also feeds the in-app update prompt via the update feed's `releaseNotes`).
- **Code signing is wired and dormant**: each job checks for its own certificate secret at job level
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
- **The *packaged* app cannot run on this machine either — measured, 2026-09-16.** Downloaded the
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

## What's next (all of it needs a human's resources)

| Item | Needs |
| --- | --- |
| Activate code signing & notarization | The 7 secrets + an Apple Developer account + a Windows cert |
| VPN verification (routing, split-tunnel, unreachable-after-failure) | A live Windows session |
| Linux packaged window-icon check | Real Linux hardware |
| Proxy stuck-connection root cause | A live repro + `chrome://net-export` capture |
| Single-connection audio-fix fallback conflict | A controlled live repro (testing was deliberately stopped to avoid locking the account) |
| "Channel is currently broken" surface | Frequency data: how often channels are genuinely dead |
| Manual quality-level selection | A provider that serves multi-variant streams (the current one serves one flat rendition) |
| Windows ARM installer | An arm64 ffmpeg binary to bundle (`ffmpeg-static` ships none) |

## Known rough edges

- **No UI interaction has been runtime-verified by a human yet**: overlays and components now have
  rendering tests (0.7.82) and the logic is well covered, but nobody has clicked through the EPG
  mapping editor, My Categories (drag-and-drop especially), the bulk-apply button, the preview's
  guide-source line or the update prompt's notes in a running window. A real pass is still the
  highest-value thing outstanding.
- Bulk-applying suggestions works per source; there is no cross-source "do all sources at once"
  action (each source's mappings are deliberately separate).
- `docs/` dates from 2026-09-14.
