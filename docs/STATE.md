# Project state

_A consolidated handover snapshot, written 2026-09-14 at v0.7.74. `ROADMAP.md` remains the
authoritative, per-release history — this page is the "where are we and why" summary for whoever
picks this up next (human or agent)._

## TL;DR

AllisonIPTV is a working desktop IPTV client (Electron + React + TypeScript) in daily use against a
real Xtream provider with a ~30k-channel catalog. Current release: **v0.7.74** (see ROADMAP for the
full history). Test suite: **280 passing**. CI (typecheck/lint/test/build) and the three-platform
Release workflow are both green on every tagged release.

The last two days of work (0.7.65 → 0.7.74) were almost entirely about the **EPG system** and the
**release pipeline**; both are now in a genuinely complete state for the provider in use.

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
   later days).

## Other features worth knowing about

- **My Categories** (`CustomCategoriesModal.tsx`, `lib/customCategories.ts`) — user-made Live TV
  groupings pinned at the top of the sidebar, filled by search, reordered by drag-and-drop or the
  ⬆⬇ buttons, persisted in `settings.customCategories`. Stream ids are provider-scoped: unresolved
  ids are skipped for display but retained in the stored order.
- **Playback fallbacks** — `transcodeService.ts` remuxes unsupported audio (EC-3/AC-3) to AAC via
  the bundled ffmpeg, mapping one text-based subtitle stream as a WebVTT rendition with a
  hand-written master playlist, a grace fallback, and a bitmap-codec auto-retry.
- **VPN** — OpenVPN profiles (requires OpenVPN installed), split-tunnel to the provider only,
  orphaned-session recovery on launch.
- **Auto-update** — electron-updater against GitHub Releases, with an in-app prompt.

## Release & CI/CD

- Push `main` → **CI** workflow (Node 20: typecheck, lint, test, build).
- Push a `v*` tag → **Release** workflow: three explicit jobs (mac / windows / linux), each building
  and publishing installers + update feeds to the GitHub Release.
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
- Tests are vitest, logic-level (no component rendering). The store's own control flow is covered
  via prototype-level spies on the client classes; `window.api` is stubbed per-test.
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

- Unresolved/unmapped EPG channels are visible (the report names them) but not fixable in bulk
  beyond the suggestion chips — there is no "auto-apply suggestions above N%" button.
- `docs/` is new as of this file.
