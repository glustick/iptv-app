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
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import WebSocket from 'ws'

const PORT = 9222
const APP = process.env.SMOKE_APP ?? join(homedir(), 'Applications/AllisonIPTV.app')
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
  await sleep(2500)
  execFileSync('open', ['-a', APP, '--args', `--remote-debugging-port=${PORT}`])
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

    // The EPG match report: the app's own account of matching at this provider's real scale. A real
    // provider's guide is megabytes, so this waits for the report rather than assuming it's ready.
    await click('button.icon-button[title="Settings"]')
    let epgReport = null
    for (let i = 0; i < 60; i++) {
      const settingsOpen = await evaluate(cdp, '!!document.querySelector(".settings-card")')
      if (!settingsOpen) {
        await click('button.icon-button[title="Settings"]')
      }
      epgReport = await evaluate(cdp, 'document.querySelector(".epg-match-report")?.innerText ?? null')
      if (epgReport) break
      await sleep(1000)
    }
    console.log('=== EPG match report at real scale ===\n' + (epgReport ?? '(no report block yet)'))
    const issues = await evaluate(
      cdp,
      'JSON.stringify([...document.querySelectorAll(".epg-source-issue")].map((e) => e.innerText.slice(0, 90)))'
    )
    console.log('source issues:', issues)
    const sources = await evaluate(
      cdp,
      'JSON.stringify([...document.querySelectorAll(".epg-source-url")].map((e) => e.innerText.slice(0, 60)))'
    )
    console.log('sources listed:', sources)
    await click('.settings-card .modal-close')
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

  // --probe-settings: open Settings and dump it, which is where the EPG match report lives.
  if (process.argv.includes('--probe-settings')) {
    await evaluate(cdp, 'document.querySelector("button.icon-button[title=\'Settings\']")?.click()')
    await sleep(1500)
    const report = await evaluate(
      cdp,
      'document.querySelector(".epg-match-report")?.innerText ?? "(no match report block)"'
    )
    const sources = await evaluate(cdp, 'document.querySelector(".lock-list")?.innerText ?? "(no sources list)"')
    console.log('=== EPG sources list ===\n' + sources)
    console.log('=== EPG match report ===\n' + report)
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

  // The provider's own per-channel listing wins its slot…
  await check("the id-matched channel shows the provider's own listing", has('Short EPG Title'))
  // …while a channel the provider has nothing for is filled from the guide POOL, matched only by
  // the relaxed tier. This is the case the prefill guard used to skip (see the store's comment).
  await check('the relaxed-tier-matched channel shows its pooled guide listing', has("Two's Show"))
  // And a channel no source covers honestly shows nothing, rather than a blank row that looks broken.
  await check('the unmatched channel reports no programme data', has('No programme data'))
  // Provenance line under the preview: which source is feeding this channel.
  await check('the preview names the guide source', has('Guide:'))

  // Settings → the EPG match report, which is the app's own account of what it matched.
  await click('button.icon-button[title="Settings"]')
  await sleep(1200)
  await check('the match report counts the relaxed-tier match', has('1 by relaxed match'))
  await check('the match report accounts for the unmatched channel', has('No match for: Unmatched Channel'))
  // Close Settings via ITS OWN close button: several overlays carry `.modal-close`, and the first
  // one in the DOM belongs to the channel preview panel — clicking that left Settings open, which
  // then made the Escape check below look like a failure when Escape was behaving correctly.
  await click('.settings-card .modal-close')
  await check('Settings closes again', '!document.querySelector(".settings-card")', 8000)

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
