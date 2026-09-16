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

function quitApp() {
  try {
    execFileSync('osascript', ['-e', 'quit app "AllisonIPTV"'], { stdio: 'ignore' })
  } catch {
    // not running — fine
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
  const check = async (label, expression) => {
    const value = await evaluate(cdp, expression)
    expectations.push({ label, ok: !!value })
    console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`)
  }
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
  await sleep(200)
  await click('.modal-close')

  // The My Categories manager, and — since both were real bugs once — that Escape closes it and
  // that it opens on the tab for the section it was launched from.
  await click('.my-categories-manage')
  await sleep(800)
  await check('the My Categories manager opens', has('My Categories'))
  await check('the manager offers a tab per catalogue kind', has('Live TV') && has('Movies') && has('Series'))
  await pressEscape()
  await sleep(600)
  await check('Escape closes the manager', '!document.body.innerText.includes("My Categories")')

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
