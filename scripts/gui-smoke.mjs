// Drives the real app over CDP to verify UI behaviour that unit tests and the synthetic provider
// can't reach: that the window renders, that the sidebar/categories/EPG render real data, and that
// the interactive surfaces (preview, settings, the My Categories manager, Escape handling) behave.
//
// It launches the app through LaunchServices (`open --args`), so nothing about the launch path is
// special-cased, and talks to the renderer with the DevTools protocol — reading the DOM rather
// than taking screenshots, which keeps it permission-free.
//
//   node scripts/gui-smoke.mjs            run the assertions
//   node scripts/gui-smoke.mjs --probe    dump the UI (text + interactive elements) and exit
//
// Prerequisites: the synthetic provider running (`node scripts/mock-provider.mjs 8123`) and a
// profile pointing at it (see docs/STATE.md). Exits non-zero if any assertion fails.
import { execFileSync, spawn } from 'child_process'
import { existsSync, openSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import WebSocket from 'ws'

const PORT = 9222
const APP = process.env.SMOKE_APP ?? join(homedir(), 'Applications/AllisonIPTV.app')
// The app's own stdout/stderr, captured from the launch below. This is the only place the main
// process's ffmpeg commands and their stderr appear — `open` discards both — and it is what makes a
// silent transcode failure (ffmpeg refusing a subtitle mapping, say, which the app then retries
// without subtitles) diagnosable instead of invisible.
const APP_LOG = process.env.SMOKE_APP_LOG ?? join(tmpdir(), 'allisoniptv-smoke-app.log')
const probe = process.argv.includes('--probe')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Quits any running instance before launching a fresh one. The graceful path is tried first but
 * BOUNDED — AppleScript's `quit` blocks forever if the app has a modal open (an update prompt, for
 * instance), which hung a whole run once — and a forced kill follows regardless, since every run
 * launches a new instance anyway.
 */
function quitApp() {
  try {
    execFileSync('osascript', ['-e', 'quit app "AllisonIPTV"'], { stdio: 'ignore', timeout: 8000 })
  } catch {
    // not running, unresponsive, or showing a modal — the force-quit below covers all three
  }
  try {
    execFileSync('pkill', ['-x', 'AllisonIPTV'], { stdio: 'ignore', timeout: 5000 })
  } catch {
    // nothing to kill
  }
  try {
    execFileSync('sleep', ['2'])
  } catch {
    // sleep is always present; ignore
  }
}

/**
 * Removes mappings created by previous smoke runs (only those pointing at the synthetic provider —
 * this can never touch a real source) so each run starts from the same state. Without it, the
 * second run finds the residue already mapped and the fresh-state assertions fail for the wrong
 * reason.
 */
function resetTestMappings() {
  const cfgPath = join(homedir(), 'Library/Application Support/iptv-app/config.json')
  const storagePath = join(homedir(), 'Desktop/Development/iptv-app/src/renderer/src/lib/storage.ts')
  if (!existsSync(cfgPath) || !existsSync(storagePath)) return
  try {
    const keys = Object.fromEntries(
      [...readFileSync(storagePath, 'utf8').matchAll(/const (\w+_KEY) = '([^']+)'/g)].map((m) => [m[1], m[2]])
    )
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const settings = cfg[keys.SETTINGS_KEY]
    if (!settings || !Array.isArray(settings.epgChannelMappings)) return
    const before = settings.epgChannelMappings.length
    settings.epgChannelMappings = settings.epgChannelMappings.filter(
      (m) => !String(m.sourceUrl).includes('127.0.0.1:8123')
    )
    if (settings.epgChannelMappings.length !== before) {
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
      console.log(`reset ${before - settings.epgChannelMappings.length} mapping(s) left by a previous run`)
    }
  } catch (err) {
    console.log('could not reset test mappings:', err.message.slice(0, 60))
  }
}

async function findTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // devtools endpoint not up yet
    }
    await sleep(500)
  }
  throw new Error('CDP endpoint never came up — is the app launching?')
}

function connect(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    const entry = pending.get(msg.id)
    if (entry) {
      pending.delete(msg.id)
      entry(msg)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  const send = (method, params) =>
    new Promise((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
  return { ready, send, close: () => ws.close() }
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text)
  return res.result?.result?.value
}

const PROBE = `(() => {
  const els = [...document.querySelectorAll('button, a, input, select, [role="button"]')]
    .filter((e) => e.offsetParent !== null)
    .slice(0, 60)
    .map((e) => ({ tag: e.tagName.toLowerCase(), cls: e.className?.toString().slice(0, 60), label: e.getAttribute('aria-label'), title: e.getAttribute('title'), text: (e.textContent || '').trim().slice(0, 40) }))
  return { title: document.title, text: document.body.innerText.slice(0, 1500), els }
})()`

async function main() {
  if (!existsSync(APP)) throw new Error(`app not found at ${APP} — build/install it or set SMOKE_APP`)
  quitApp()
  resetTestMappings()
  await sleep(2500)
  // Launched as the bundled binary directly rather than through `open`, so stdout/stderr can be
  // captured (see APP_LOG). Same executable `open` would run, same arguments.
  const appLog = openSync(APP_LOG, 'w')
  spawn(join(APP, 'Contents/MacOS/AllisonIPTV'), [`--remote-debugging-port=${PORT}`], {
    detached: true,
    stdio: ['ignore', appLog, appLog]
  }).unref()
  const target = await findTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready

  // Wait for the renderer to be alive.
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(cdp, 'document.readyState === "complete" && !!document.body')
    if (ready) break
    await sleep(500)
  }

  // The app opens on its login screen even with a saved profile, so the run starts by using it —
  // which exercises the real connect flow rather than assuming an already-connected window.
  const onLogin = await evaluate(cdp, '!!document.querySelector("button.profile-connect")')
  if (onLogin) {
    console.log('using the saved profile from the login screen…')
    await evaluate(cdp, 'document.querySelector("button.profile-connect").click()')
    for (let i = 0; i < 60; i++) {
      const connected = await evaluate(cdp, 'document.body.innerText.includes("Live News")')
      if (connected) break
      await sleep(500)
    }
  }

  // Shared helpers — defined before the mode blocks below, which use them.
  const text = () => evaluate(cdp, 'document.body.innerText')
  const has = (needle) => `document.body.innerText.includes(${JSON.stringify(needle)})`
  const click = (selector) => evaluate(cdp, `!!document.querySelector(${JSON.stringify(selector)})?.click() || true`)
  const pressEscape = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      })
    }
  }

  // --live [profileNameFragment]: switch to a real provider profile and REPORT what the app does
  // against it. Unlike the synthetic run this asserts nothing — the catalogue, the guide data and
  // the streams are whatever the provider has — it gathers evidence at real scale (category and
  // channel counts, the EPG match report, and whether a real live channel decodes) so findings can
  // be discussed rather than guessed at.
  if (process.argv.includes('--live')) {
    const want = process.argv[process.argv.indexOf('--live') + 1]
    const switchable = await evaluate(cdp, '!!document.querySelector("button.disconnect")')
    if (switchable) {
      await click('button.disconnect') // → the profile chooser
      await sleep(1200)
    }
    const profiles = await evaluate(
      cdp,
      'JSON.stringify([...document.querySelectorAll("button.profile-connect")].map((b, i) => ({ i, text: (b.textContent || "").slice(0, 60) })))'
    )
    console.log('profiles on offer:', profiles)
    const list = JSON.parse(profiles)
    const chosen = want
      ? list.find((p) => p.text.toLowerCase().includes(want.toLowerCase()))
      : list.find((p) => !/synthetic/i.test(p.text))
    if (!chosen) throw new Error('no matching provider profile found — add it in the app first')
    console.log('connecting with:', chosen.text)
    await evaluate(
      cdp,
      `document.querySelectorAll("button.profile-connect")[${chosen.i}].click()`
    )
    // Real providers take longer than the fixture: give the catalogue time to land.
    let loaded = false
    for (let i = 0; i < 90; i++) {
      loaded = await evaluate(cdp, 'document.querySelectorAll("button.epg-row-channel").length > 0')
      if (loaded) break
      await sleep(1000)
    }
    const report = {
      sidebarCategories: await evaluate(cdp, 'document.querySelectorAll("button.category").length'),
      channelRows: await evaluate(cdp, 'document.querySelectorAll("button.epg-row-channel").length'),
      rowsWithListings: await evaluate(
        cdp,
        '[...document.querySelectorAll("button.epg-row-channel")].filter((r) => !/No programme data/.test(r.parentElement?.innerText || "")).length'
      ),
      errorVisible: await evaluate(cdp, 'document.body.innerText.includes("Playback error")')
    }
    console.log('catalogue:', JSON.stringify(report))

    // The source cards (provider guide + each user source, with their match summaries) live on the
    // Guide & EPG surface now — its own modal, opened from the top bar (0.7.92). A real provider's
    // guide is megabytes, so this waits for the cards to fill in rather than assuming they're ready.
    await click('button.icon-button[title="Guide & EPG"]')
    let epgReport = null
    for (let i = 0; i < 60; i++) {
      const guideOpen = await evaluate(cdp, '!!document.querySelector(".guide-card")')
      if (!guideOpen) {
        await click('button.icon-button[title="Guide & EPG"]')
      }
      epgReport = await evaluate(cdp, 'document.querySelector(".guide-card .guide-section")?.innerText ?? null')
      if (epgReport) break
      await sleep(1000)
    }
    console.log('=== EPG sources + matching at real scale ===\n' + (epgReport ?? '(no guide content yet)'))
    const issues = await evaluate(
      cdp,
      'JSON.stringify([...document.querySelectorAll(".epg-source-issue")].map((e) => e.innerText.slice(0, 90)))'
    )
    console.log('source issues:', issues)
    const sources = await evaluate(
      cdp,
      'JSON.stringify([...document.querySelectorAll(".guide-source-title")].map((e) => e.innerText.slice(0, 60)))'
    )
    console.log('sources listed:', sources)
    await click('.guide-card .modal-close')
    await sleep(800)

    // One real live channel: does it decode? (Short by design — the account has connection limits.)
    await click('.watch-now-button')
    await sleep(12000)
    const videos = await evaluate(
      cdp,
      `JSON.stringify([...document.querySelectorAll('video')].map((v) => ({ cls: v.className, readyState: v.readyState, t: Number(v.currentTime.toFixed(2)), paused: v.paused, error: v.error ? v.error.code : null })))`
    )
    console.log('video state after 12s:', videos)
    console.log('playback error text:', await evaluate(cdp, 'document.body.innerText.includes("Playback error")'))
    cdp.close()
    process.exit(0)
  }

  // --eval "<expression>": run one expression against the connected app and print the JSON result.
  // Handy for ad-hoc investigation without editing this script.
  if (process.argv[2] === '--eval') {
    const expression = process.argv[3]
    const value = await evaluate(cdp, expression)
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
    cdp.close()
    process.exit(0)
  }

  // --probe-guide: open the Guide & EPG surface and dump its source cards and match summaries.
  if (process.argv.includes('--probe-guide')) {
    await evaluate(cdp, 'document.querySelector("button.icon-button[title=\'Guide & EPG\']")?.click()')
    await sleep(1500)
    const sources = await evaluate(
      cdp,
      '[...document.querySelectorAll(".guide-source-card")].map((c) => c.innerText).join("\n---\n") || "(no source cards)"'
    )
    const stats = await evaluate(cdp, 'document.querySelector(".guide-stats")?.innerText ?? "(no stats row)"')
    console.log('=== Guide stats ===\n' + stats)
    console.log('=== Guide source cards ===\n' + sources)
    cdp.close()
    process.exit(0)
  }

  if (probe) {
    const dump = await evaluate(cdp, PROBE)
    console.log('=== title ===\n' + dump.title)
    console.log('=== visible text ===\n' + dump.text)
    console.log('=== interactive elements ===')
    for (const el of dump.els) console.log(JSON.stringify(el))
    cdp.close()
    process.exit(0)
  }

  const expectations = []
  /**
   * Assertions poll rather than fire once: several of these surfaces fill in asynchronously — the
   * guide pool in particular arrives only after a multi-megabyte download completes, well after
   * the window first renders — so a single-shot check reports flakiness, not behaviour.
   */
  const check = async (label, expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    let value = false
    while (Date.now() < deadline) {
      value = await evaluate(cdp, expression)
      if (value) break
      await sleep(500)
    }
    expectations.push({ label, ok: !!value })
    console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`)
  }

  await check('the window renders content', 'document.body.innerText.trim().length > 20')
  await check('the provider category is listed in the sidebar', has('Live News'))
  await check('channel matched by EPG id is listed', has('One HD'))
  await check('channel matched through the relaxed tier is listed', has('101 Two HD'))
  await check('the channel the guide misses is listed', has('Unmatched Channel'))
  await check('the residue channel (close to a guide name, but not a match) is listed', has('Channel One News Extra'))

  // The provider's own per-channel listing wins its slot…
  await check("the id-matched channel shows the provider's own listing", has('Short EPG Title'))
  // …while a channel the provider has nothing for is filled from the guide POOL, matched only by
  // the relaxed tier. This is the case the prefill guard used to skip (see the store's comment).
  await check('the relaxed-tier-matched channel shows its pooled guide listing', has("Two's Show"))
  // And a channel no source covers honestly shows nothing, rather than a blank row that looks
  // broken. That is now the residue channel: with a custom source configured, the provider's
  // "Unmatched Channel" genuinely is covered.
  // Asserted through the app's own report rather than the grid row: the row's DOM doesn't carry the
  // "No programme data" label where this used to look for it, and the report is the more precise
  // statement anyway — the channel is listed as unmatched by EVERY source.
  // Provenance line under the preview: which source is feeding this channel.
  await check('the preview names the guide source', has('Guide:'))

  // Settings is decluttered: it now links to the guide rather than carrying all of it (0.7.92) —
  // so first confirm the link is there and the old, sprawling EPG section is gone from Settings.
  await click('button.icon-button[title="Settings"]')
  await sleep(1000)
  await check('Settings links to the guide surface', has('Open guide settings'))
  await check(
    'Settings no longer carries the EPG panel itself',
    '![...document.querySelectorAll(".settings-card h3")].some((h) => h.textContent === "EPG sources")'
  )
  await click('.settings-card .modal-close')
  await check('Settings closes again', '!document.querySelector(".settings-card")', 8000)

  // The Guide & EPG surface — its own modal — holds the source cards and the match report.
  await click('button.icon-button[title="Guide & EPG"]')
  await sleep(1200)
  await check('the guide surface opens', '!!document.querySelector(".guide-card")')
  await check('the provider guide is shown as a source card', has('Provider guide (xmltv.php)'))
  await check('the match report counts the relaxed-tier match', has('1 by relaxed match'))
  await check('the guide lists the user-added source alongside the provider guide', has('custom.xml'))
  // The report lists unmatched channels per source; the residue channel must appear in one of them
  // (position-independent: the row and the ordering both vary). The unmatched names are behind a
  // collapsed disclosure now, so open it first — innerText skips hidden content.
  await evaluate(cdp, '[...document.querySelectorAll("details.guide-unmatched")].forEach((d) => (d.open = true))')
  await check(
    'a channel no source covers is reported unmatched by at least one source',
    '/No match for:[^|]*Channel One News Extra/.test(document.body.innerText)',
    30000
  )
  // Close the guide via ITS OWN close button (not a bare `.modal-close`): several overlays carry
  // that class, and the first one in the DOM belongs to the channel preview panel — clicking that
  // left the guide open, which once made the Escape check below look like a failure when Escape
  // was behaving correctly.
  // The bulk apply, driven through the UI: it resolves the whole catalogue chunked (0.7.88) so the
  // window keeps painting, and must report what it did. The assertion accepts either outcome,
  // because a re-run finds the residue already mapped — what it is really guarding is that the run
  // completes and reports at all, which is exactly what a synchronous five-second freeze broke.
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.epg-bulk-apply button')].find((b) => /Apply across/.test(b.textContent))?.click() || true`
  )
  await check(
    'the bulk apply completes and reports a result',
    `/Applied \\d+ mapping|No unmatched channel scored/.test(document.body.innerText)`,
    120000
  )
  await check('the match report reflects the manual mapping it placed', has('by manual mapping'), 20000)

  await click('.guide-card .modal-close')
  await check('the guide surface closes again', '!document.querySelector(".guide-card")', 8000)

  // The My Categories manager, and — since both were real bugs once — that Escape closes it and
  // that it opens on the tab for the section it was launched from.
  await click('.my-categories-manage')
  await sleep(800)
  await check('the My Categories manager opens', has('My Categories'))
  await check('the manager offers a tab per catalogue kind', has('Live TV') && has('Movies') && has('Series'))
  // Escape closes ONE layer, outermost first — the update prompt outranks the manager, and when
  // this run installs a build older than the latest release (which happens whenever a release has
  // just shipped) that prompt is legitimately open. Assert the whole ordering rather than assuming
  // the manager is the top layer.
  const openLayers = await evaluate(
    cdp,
    'JSON.stringify({ settings: !!document.querySelector(".settings-card"), manager: !!document.querySelector(".custom-cat-card"), prompt: document.body.innerText.includes("is available") })'
  )
  console.log('overlays open before Escape:', openLayers)
  const promptOpen = await evaluate(cdp, 'document.body.innerText.includes("is available")')
  if (promptOpen) {
    console.log('(an update prompt is open — it is the outermost overlay)')
    await pressEscape()
    await check(
      'Escape dismisses the update prompt before anything beneath it',
      '!document.body.innerText.includes("is available")',
      8000
    )
  }
  await pressEscape()
  await check('Escape then closes the manager', '!document.querySelector(".custom-cat-card")', 8000)

  // --- VOD (before any live playback on purpose) ---------------------------------------------
  // Sequenced ahead of the live sections below because switching to Movies after a live channel has
  // been through the audio-fix fallback left the VOD catalogue fetch hanging on this harness's
  // mock provider — a fresh, un-transcoded session fetches it in seconds. A fixture artefact or a
  // real single-connection symptom, this ordering keeps the check honest either way.
  // --- VOD: the file's own track probe, the picker, and the subtitle transcode rendition --------
  // The fixture movie carries a real mov_text subtitle track (with a language tag, which is what
  // the picker displays). VOD plays as a plain video.src assignment, so none of this is visible to
  // hls.js: the app probes the file's own streams with ffmpeg on load, offers what it finds, and —
  // only once one is chosen — restarts playback from an ffmpeg remux that carries the subtitle as a
  // WebVTT rendition. Previously nothing in this fixture had a subtitle track at all, so the probe,
  // the picker and that rendition were entirely unexercised by machine. All three steps asserted.
  // Bring the window forward first. The VOD grid is virtualised and only renders once its container
  // has a measured size, and an occluded window can defer that layout — which showed up as a flaky
  // "the Movies tab lists the fixture movie" failure (empty grid, no error, listing itself correct)
  // that had nothing to do with the app: the exact same build passed it on the next run.
  try {
    execFileSync('osascript', ['-e', 'tell application "AllisonIPTV" to activate'], {
      stdio: 'ignore',
      timeout: 5000
    })
  } catch {
    // best-effort; the poll below still decides
  }
  await sleep(800)
  await evaluate(
    cdp,
    `[...document.querySelectorAll('button.tab')].find((b) => b.textContent.trim() === 'Movies')?.click() || true`
  )
  // Switching tabs kicks off a VOD category + catalogue fetch, so the grid is genuinely empty for
  // a few seconds — clicking immediately (as an earlier version did) hits nothing and every later
  // assertion fails for that one reason. Poll for the card instead.
  await check(
    'the Movies tab lists the fixture movie',
    `[...document.querySelectorAll('.channel-item--grid')].some((b) => b.textContent.includes('A Movie'))`,
    45000
  )
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.channel-item--grid')].find((b) => b.textContent.includes('A Movie'))?.click() || true`
  )
  // Diagnostic (kept: it prints one line and is the only way to tell an empty catalogue from a
  // failed tab switch when this section ever regresses).
  console.log(
    'movie section state:',
    await evaluate(
      cdp,
      `JSON.stringify({
        tab: document.querySelector('button.tab.active')?.textContent,
        cards: document.querySelectorAll('.channel-item--grid').length,
        gridBox: (() => {
          const g = document.querySelector('.media-grid-wrap')
          if (!g) return null
          const box = g.getBoundingClientRect()
          return Math.round(box.width) + 'x' + Math.round(box.height)
        })(),
        empty: document.querySelector('.empty-state')?.textContent ?? null,
        error: document.querySelector('.banner-error, .error-message, [role=alert]')?.textContent?.slice(0, 90) ?? null,
        text: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 180)
      })`
    )
  )
  await check('the VOD player opens for a movie', `!!document.querySelector('video.player-video')`, 20000)

  await check(
    "the subtitle probe finds the file's own track and offers it",
    `(() => {
      // "Subtitles" now belongs to VOD's ffmpeg-level picker alone — hls.js's rendition picker is
      // labelled "Subtitle track" — because the two used to be indistinguishable, which is both a
      // user-facing confusion and what made this assertion pass against the wrong control.
      const s = document.querySelector('label[title="Subtitles"] select')
      return !!s && [...s.options].some((o) => /eng/i.test(o.textContent) && !o.disabled)
    })()`,
    60000
  )

  // Pick it through the real control (React's own change handling, not a store call).
  const picked = await evaluate(
    cdp,
    `(() => {
      const s = document.querySelector('label[title="Subtitles"] select')
      const o = s && [...s.options].find((x) => !x.disabled && x.value !== '-1')
      if (!o) return 'none'
      s.value = o.value
      s.dispatchEvent(new Event('change', { bubbles: true }))
      return o.textContent
    })()`
  )
  if (process.env.SMOKE_VERBOSE) console.log('subtitle option chosen:', picked)

  await check(
    'choosing a subtitle ends in a real subtitle rendition on the playing element',
    `(() => { const v = document.querySelector('video.player-video'); return !!v && v.textTracks.length > 0 })()`,
    150000
  )
  await check(
    'playback still decodes with the subtitle track selected',
    `(() => { const v = document.querySelector('video.player-video'); return !!v && v.readyState >= 2 && v.currentTime > 0.5 })()`,
    90000
  )
  await check(
    'no playback error is surfaced after the subtitle switch',
    '!document.body.innerText.includes("Playback error")',
    5000
  )

  // Leave VOD before the live checks: starting a second stream on top of an active transcode is
  // exactly the contention the app's own comments warn about, and this run isn't testing that.
  await pressEscape()
  await sleep(1500)
  // ...and go back to Live TV, which every check below assumes.
  await evaluate(
    cdp,
    `[...document.querySelectorAll('button.tab')].find((b) => b.textContent.trim() === 'Live TV')?.click() || true`
  )
  await sleep(4000)

  // Playback LAST: starting a stream mounts the player over the UI, so it must not sit in the
  // middle of the overlay assertions above. This is the check that a Chromium/Electron upgrade can
  // break while everything else still passes — it requires real decoding, not just a loaded URL.
  await click('.watch-now-button')
  await check('a video element appears for playback', '!!document.querySelector("video")', 20000)
  // A page can hold more than one video element (the preview panel has its own), so this asks
  // whether ANY of them is decoding and advancing rather than trusting the first one found.
  const videoState = await evaluate(
    cdp,
    `JSON.stringify([...document.querySelectorAll('video')].map((v) => ({
      cls: v.className, readyState: v.readyState, currentTime: Number(v.currentTime.toFixed(2)),
      paused: v.paused, ended: v.ended, error: v.error ? v.error.code : null,
      src: (v.currentSrc || '').split('/').slice(-1)[0]
    })))`
  )
  console.log('video elements:', videoState)
  await check(
    'playback decodes and advances',
    `[...document.querySelectorAll('video')].some((v) => v.readyState >= 2 && v.currentTime > 0.5)`,
    30000
  )
  await check('no playback error is surfaced', '!document.body.innerText.includes("Playback error")', 5000)

  // The E-AC-3 ("Dolby") channel: the app should detect the unsupported audio and engage its ffmpeg
  // audio-fix fallback, which then has to end in actual playback. That whole path is invisible to
  // an AAC-only fixture, and it is the feature most exposed to a Chromium upgrade.
  await pressEscape() // leave the player
  await sleep(1200)
  await evaluate(
    cdp,
    `[...document.querySelectorAll('button.epg-row-channel')].find((b) => b.textContent.includes('Unmatched Channel'))?.click() || true`
  )
  await sleep(1500)
  await click('.watch-now-button')
  await check(
    'the E-AC-3 channel still ends up playing (audio-fix fallback)',
    `[...document.querySelectorAll('video')].some((v) => v.classList.contains('player-video') && v.readyState >= 2 && v.currentTime > 0.5)`,
    90000
  )
  // ...and that the transcoded stream is what is actually being played. Video decoding alone does
  // NOT prove the fallback worked: the original Dolby stream decodes video perfectly well, it just
  // produces no audio, so the assertion above passes even when the fallback never engages. Asking
  // the resource timeline whether the player fetched from the local transcode route does prove it.
  await check(
    'the audio-fix transcode is actually what is being played',
    `[...performance.getEntriesByType('resource')].some((e) => e.name.includes('/__transcode/'))`,
    20000
  )


  const finalText = await text()
  if (process.env.SMOKE_VERBOSE) console.log('--- final UI text ---\n' + finalText)

  cdp.close()
  const failed = expectations.filter((e) => !e.ok)
  console.log(`\n${expectations.length - failed.length}/${expectations.length} checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('smoke run failed:', err.message)
  process.exit(2)
})
