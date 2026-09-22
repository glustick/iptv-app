import {
  app,
  shell,
  dialog,
  BrowserWindow,
  ipcMain,
  net,
  session,
  nativeImage,
  Notification,
  Menu,
  safeStorage,
  powerSaveBlocker,
  type MenuItemConstructorOptions
} from 'electron'
import { join, extname, dirname, basename, isAbsolute, sep } from 'path'
import { createServer } from 'http'
import { connect as netConnect, type Socket } from 'net'
import { URL } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, readdir, copyFile } from 'fs/promises'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { lookup as dnsLookup } from 'dns/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Store from 'electron-store'
import { autoUpdater } from 'electron-updater'
import ffmpegPathRaw from 'ffmpeg-static'
import { exec as sudoExec } from 'sudo-prompt'
import extractZip from 'extract-zip'
import { createProxyServer, type UpstreamClientRequest } from './proxyServer'
import { createFfmpegResolver } from './ffmpegResolver'
import { createTranscodeService } from './transcodeService'
import { createVpnRecoveryService } from './vpnRecoveryService'
import { buildRouteScriptText, normalizeRouteIps } from './vpnRouteScript'
import { createKeepAwakeService } from './keepAwakeService'

const execFileAsync = promisify(execFile)

// Electron resolves the app's name from package.json's "productName" (falling back to
// "name") before any of this module's own code runs — by the time a line here calls
// app.getPath('userData'), that already reflects the new "AllisonIPTV" productName added
// alongside this rename, not the "iptv-app" name the existing userData folder was created
// under. So the pre-rename location has to be reconstructed explicitly (appData is the
// OS-level user-data root and doesn't depend on the app's own name) rather than captured
// from getPath('userData'), or every user's saved server profile, favorites, and settings
// would silently go missing the first time this runs post-rename.
const legacyUserDataPath = join(app.getPath('appData'), 'iptv-app')
app.setName('AllisonIPTV')
app.setPath('userData', legacyUserDataPath)

// Required for the orphaned-VPN-session recovery below to be safe: without this, a second
// concurrently running instance (e.g. the app opened twice) would find the first instance's own,
// perfectly legitimate, still-in-use VPN recovery record and tear its live connection down out
// from under it, having no way to tell "abandoned by a process that's gone" apart from "actively
// owned by a process that's still very much running." A single-instance lock makes that
// ambiguity impossible — if this process ever reaches app.whenReady() at all, no other instance
// holds the lock, so any leftover record it finds there can only be a genuine orphan.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindowRef) return
    if (mainWindowRef.isMinimized()) mainWindowRef.restore()
    mainWindowRef.focus()
  })
}

// Electron's default behavior for either of these is a disruptive "A JavaScript error occurred
// in the main process" dialog — and, depending on what's still running, sometimes takes the
// whole app down with it. For a media player, an unhandled error in some background event
// callback (a network error handler, a timer) is almost always recoverable — the user just
// loses whatever that one operation was doing, not the app itself — so logging and continuing
// serves them far better than a crash. (Found the hard way: a Promise-returning Electron API
// called fire-and-forget without a .catch() produced exactly this dialog for a real user.)
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

const store = new Store()

// Deliberately not persisted through BACKUP_KEYS below — this is purely local recovery
// bookkeeping for *this* machine's own openvpn process, not user data, and would be meaningless
// (or actively wrong) on a different machine or after a restore. See vpnRecoveryService.ts's own
// doc comment for why this exists and how it's used.
const vpnRecoveryService = createVpnRecoveryService({
  store,
  connect: (opts, onConnect) => netConnect(opts, onConnect),
  removeDir: (path) => rm(path, { recursive: true, force: true })
})

// Every top-level electron-store key a backup covers — kept as one list so export and import
// can't drift out of sync with each other (export always writes exactly these keys; import only
// ever touches these keys, ignoring anything else a file might contain). Deliberately excludes
// nothing storage.ts itself persists today: profiles (including Xtream credentials, which this
// app already stores in plaintext — see xtream.ts — so a backup file is exactly as sensitive as
// the config file it's copied from, not a new exposure), favorites, history, episode progress,
// and settings (which itself carries VPN profiles and the parental PIN, encrypted the same way
// they already are on disk — safeStorage ties that encryption to this specific machine's OS
// keychain, so an imported value that can't be decrypted on a *different* machine already
// degrades to "treat as unset" rather than a hard failure, the same fallback PIN/VPN storage
// already has for exactly this situation).
const BACKUP_KEYS = [
  'xtream_profiles',
  'active_profile_id',
  'favorites',
  'favorite_groups',
  'recently_watched',
  'episode_progress',
  'epg_reminders',
  'settings'
] as const

// app.getVersion() already reads package.json's "version" natively, but buildNumber is a
// custom field with no built-in getter — app.getAppPath() resolves correctly both in dev and
// packaged (inside app.asar, which Node's fs can read transparently), so this mirrors how
// Electron itself locates package.json rather than assuming a fixed relative path.
const pkgMeta = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
  buildNumber: number
}

/**
 * ffmpeg-static's exported path always points inside app.asar, even once packaged — the
 * actual binary lives in app.asar.unpacked (see build.asarUnpack in package.json), since a
 * native executable can't be run from inside a virtual asar archive. This substitution is
 * only meaningful once packaged; in dev the path already resolves directly on disk.
 */
const bundledFfmpegPath = app.isPackaged
  ? ffmpegPathRaw?.replace('app.asar', 'app.asar.unpacked')
  : ffmpegPathRaw

// A system-installed ffmpeg, when one exists and actually works, is preferred over the
// bundled copy at runtime — see ffmpegResolver.ts for why this doesn't shrink the installer
// and isn't meant to.
const resolveFfmpegPath = createFfmpegResolver(bundledFfmpegPath ?? null, {
  platform: process.platform,
  fileExists: existsSync,
  execFile: execFileAsync
})

// Spawns ffmpeg per affected channel on demand (not for every stream — most don't need it) to
// remux around a Dolby audio codec hls.js can't parse (see Player.tsx's MEDIA_ERROR handling)
// or, for VOD/series, silent audio native <video> gives no error for at all. The actual
// spawn/poll/cleanup logic lives in transcodeService.ts, decoupled from Electron entirely so it
// can be tested directly — see transcodeService.test.ts.
const transcodeService = createTranscodeService({ resolveFfmpegPath })

// Holds off display sleep while the renderer reports actual playback (see the keepAwake:setEnabled
// handler + Player.tsx's effect) — the app-level wrapper around powerSaveBlocker, injected here
// with the real Electron API the same way the services above take theirs.
const keepAwakeService = createKeepAwakeService({
  startBlocker: (type) => powerSaveBlocker.start(type),
  stopBlocker: (id) => powerSaveBlocker.stop(id),
  isBlockerStarted: (id) => powerSaveBlocker.isStarted(id)
})

// ---------------------------------------------------------------------------
// OpenVPN (optional, off by default): tunnels only this app's own traffic to
// the configured Xtream server through a user-supplied .ovpn file — not the
// whole system's traffic, so everything else on the machine keeps using the
// normal connection. There's no maintained, bundlable cross-platform OpenVPN
// binary the way ffmpeg-static exists for ffmpeg, and creating a TUN/TAP
// network interface is a privileged kernel operation on every OS regardless
// — both mean this requires a system-installed `openvpn` and one OS
// elevation prompt each time it connects. A signed background service could
// avoid repeating that prompt, but isn't trustworthy without code signing
// (see ROADMAP.md); a one-shot elevated process that only exists for the
// life of the connection is also less standing privilege than a persistent
// root-level daemon sitting on the system indefinitely, not just simpler to
// build.
type VpnStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface VpnRuntimeState {
  status: VpnStatus
  errorMessage: string | null
  managementSocket: Socket | null
  managementBuffer: string
  tempDir: string | null
  // The single host the route-up script actually routes through the tunnel (see startVpn) —
  // kept here, not just as a local variable inside startVpn, so the proxy's own request
  // handler can tell whether a given redirect target is one of the hosts this connection
  // promised to route, without threading it through as a parameter.
  tunneledHost: string | null
  // Every IP address actually written into the OS routes (see writeRouteScript) — resolved once,
  // at connect time, via this app's own dns.lookup, entirely independent of Chromium's own DNS
  // resolution for the proxy's actual requests. Plural because a panel behind several A records
  // needs all of them routed, not just whichever one came back first. Kept so the proxy can tell
  // whether a *fresh* resolution of the same tunneled host later returns an address the routes no
  // longer cover.
  tunneledIps: string[]
}

const vpnRuntime: VpnRuntimeState = {
  status: 'disconnected',
  errorMessage: null,
  managementSocket: null,
  managementBuffer: '',
  tempDir: null,
  tunneledHost: null,
  tunneledIps: []
}

// Redirect targets already reported for the current connection — reset on every new connect
// attempt (see setVpnStatus below) so a channel that keeps redirecting to the same off-tunnel
// CDN host doesn't repost the same warning on every segment request.
const warnedOffTunnelHosts = new Set<string>()
// Same de-dup rationale as warnedOffTunnelHosts, but keyed on the specific IP that turned up —
// a provider whose DNS keeps returning the same alternate IP shouldn't repost the same warning
// on every retry either.
const warnedTunnelIpChanges = new Set<string>()

function setVpnStatus(status: VpnStatus, errorMessage: string | null = null): void {
  vpnRuntime.status = status
  vpnRuntime.errorMessage = errorMessage
  if (status !== 'connected' && status !== 'connecting') {
    vpnRuntime.tunneledHost = null
    vpnRuntime.tunneledIps = []
    warnedOffTunnelHosts.clear()
    warnedTunnelIpChanges.clear()
  }
  mainWindowRef?.webContents.send('vpn:status-changed', { status, errorMessage })
}

/**
 * Appends one line to a persistent log under the OS's own log directory (macOS:
 * `~/Library/Logs/AllisonIPTV/`).
 *
 * This exists because a renderer death used to leave *no trace at all* — reported live as "the
 * screen went blank and the app died", with nothing in the macOS diagnostic reports, nothing on
 * disk, and (launched from Finder) no stdout either. Lifecycle and crash events now land here, so
 * the next occurrence is a timestamped record rather than a memory.
 *
 * Deliberately never throws: logging must not be able to break the app it is describing.
 */
function logLifecycle(message: string): void {
  try {
    const dir = app.getPath('logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'allisoniptv.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Nothing useful to do — swallowing is the whole point here.
  }
}

/** Reload-loop guard for the crash recovery below: one automatic reload per this window of time. */
const CRASH_RELOAD_SUPPRESSION_MS = 2 * 60 * 1000
let lastCrashReloadAt = 0

function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

// Simple double-quote wrapping is enough here — these are always our own generated temp-file
// paths or a user-picked .ovpn file, never arbitrary untrusted input, and this only needs to
// survive the OS-default shell sudo-prompt runs commands through.
function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

// Tunnelblick (a free, open-source OpenVPN GUI, distributed as a plain signed .dmg — no
// package manager needed) bundles the real openvpn binary inside its own .app, under a
// version-specific subdirectory that varies by release and openssl pairing — e.g.
// "openvpn-2.6.9-openssl-3.0.14" — so it has to be discovered by scanning rather than a fixed
// path the way Homebrew's install locations can be.
async function findTunnelblickOpenvpn(): Promise<string | null> {
  const opensslDir = '/Applications/Tunnelblick.app/Contents/Resources/openvpn'
  try {
    const entries = await readdir(opensslDir)
    for (const entry of entries) {
      const candidate = join(opensslDir, entry, 'openvpn')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // Tunnelblick isn't installed — not an error, just one option among several.
  }
  return null
}

// The command sudo-prompt runs executes in an elevated shell that often has a far more minimal
// PATH than the user's own interactive shell — confirmed live: a real user had openvpn
// reachable from their normal terminal, but the elevated command still failed with "openvpn:
// command not found". Checking common install locations directly, then falling back to `which`
// in the *user's* (non-elevated) environment, avoids depending on whatever PATH the elevated
// shell happens to construct.
async function findOpenvpnBinary(): Promise<string> {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\OpenVPN\\bin\\openvpn.exe', 'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe']
      : [
          '/opt/homebrew/sbin/openvpn', // Homebrew on Apple Silicon
          '/usr/local/sbin/openvpn', // Homebrew on Intel Mac / many Linux installs
          '/usr/local/bin/openvpn',
          '/usr/sbin/openvpn', // apt on Debian/Ubuntu
          '/usr/bin/openvpn'
        ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  if (process.platform === 'darwin') {
    const tunnelblickPath = await findTunnelblickOpenvpn()
    if (tunnelblickPath) return tunnelblickPath
  }
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['openvpn'])
    const resolved = stdout.split('\n')[0]?.trim()
    if (resolved) return resolved
  } catch {
    // Neither a known install path nor PATH lookup found it — fall through to the error below.
  }
  throw new Error(
    'OpenVPN is not installed on this machine (or not found in any common location). Install it — ' +
      (process.platform === 'darwin'
        ? 'via Homebrew (`brew install openvpn`) or Tunnelblick (https://tunnelblick.net/downloads.html, no Homebrew needed)'
        : process.platform === 'win32'
          ? 'from https://openvpn.net/community-downloads/'
          : 'via your package manager, e.g. `apt install openvpn`') +
      ' — then try connecting again.'
  )
}

// `--route-nopull` only suppresses routing directives the *server* pushes during connection
// negotiation — it does nothing about a directive like `redirect-gateway def1` written directly
// into the client's own .ovpn file, which a real-world config confirmed doing (a "route
// everything through the tunnel by default" config, common for consumer VPN providers, not
// something server-push-blocking touches at all). Route-up still runs after OpenVPN has already
// installed that full-tunnel redirect, so rather than relying on suppressing it, this actively
// undoes it: OpenVPN's redirect-gateway conventionally installs two /1 routes (0.0.0.0/1 and
// 128.0.0.0/1) rather than replacing the literal default route, specifically so it doesn't have
// to touch that entry — deleting those two and re-asserting the machine's original default
// (captured before connecting, via getDefaultGateway) restores normal system-wide routing, and
// only then does the one narrow route to the Xtream server get added through the tunnel.
async function getDefaultGateway(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('route', ['-n', 'get', 'default'])
      return /gateway:\s*(\S+)/.exec(stdout)?.[1] ?? null
    }
    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('ip', ['route', 'show', 'default'])
      return /default via (\S+)/.exec(stdout)?.[1] ?? null
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('route', ['print', '-4', '0.0.0.0'])
      // Windows' `route print` table format: destination, netmask, gateway, interface, metric —
      // the 0.0.0.0/0.0.0.0 row's third column is what we want.
      const match = /0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)/.exec(stdout)
      return match?.[1] ?? null
    }
  } catch {
    return null
  }
  return null
}

async function writeRouteScript(
  dir: string,
  name: string,
  xtreamIps: string[],
  action: 'add' | 'delete',
  originalGateway: string | null
): Promise<string> {
  const isWindows = process.platform === 'win32'
  const path = join(dir, isWindows ? `${name}.bat` : `${name}.sh`)
  // The script text itself (one route line per address, plus the default-gateway restore when
  // adding) comes from a pure, separately-tested function — see vpnRouteScript.ts for why: these
  // lines run as root, and a wrong one fails silently rather than throwing anywhere visible.
  const content = buildRouteScriptText({ platform: process.platform, ips: xtreamIps, action, originalGateway })
  await writeFile(path, content, { mode: 0o755 })
  if (!isWindows) await chmod(path, 0o755)
  return path
}

// OpenVPN's management interface (a local TCP socket, not privileged to connect to) is what
// makes the one-shot elevated spawn below workable at all: sudo-prompt only ever hands back the
// completed output of a single command, never a live process handle to signal later — but once
// OpenVPN is up, this plain socket can both watch its real connection state (via `>STATE:`
// notifications) and tell it to shut down cleanly (`signal SIGTERM`), without ever needing a
// second privileged operation.
function connectManagementInterface(port: number, username: string | null, password: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let retriesLeft = 20 // --daemon forks to background; the management port may not be bound the instant sudo-prompt's callback fires
    const attempt = (): void => {
      const socket = netConnect({ host: '127.0.0.1', port }, () => {
        vpnRuntime.managementSocket = socket
        socket.write('state on\n')
        if (!settled) {
          settled = true
          resolve()
        }
      })
      socket.on('error', () => {
        socket.destroy()
        if (retriesLeft-- > 0) {
          setTimeout(attempt, 500)
        } else if (!settled) {
          settled = true
          reject(new Error('Could not reach the OpenVPN management interface'))
        }
      })
      socket.on('data', (chunk: Buffer) => handleManagementData(chunk, username, password))
      socket.on('close', () => {
        vpnRuntime.managementSocket = null
        if (vpnRuntime.status !== 'disconnected') setVpnStatus('disconnected')
        void cleanupVpnTempDir()
      })
    }
    attempt()
  })
}

function handleManagementData(chunk: Buffer, username: string | null, password: string | null): void {
  vpnRuntime.managementBuffer += chunk.toString('utf8')
  const lines = vpnRuntime.managementBuffer.split('\n')
  vpnRuntime.managementBuffer = lines.pop() ?? ''
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith(">PASSWORD:Need 'Auth'")) {
      if (username && password) {
        vpnRuntime.managementSocket?.write(`username "Auth" ${username}\n`)
        vpnRuntime.managementSocket?.write(`password "Auth" ${password}\n`)
      } else {
        setVpnStatus('error', 'This VPN configuration requires a username and password')
      }
    } else if (line.startsWith('>PASSWORD:Verification Failed')) {
      setVpnStatus('error', 'VPN authentication failed — check the configured username and password')
    } else if (line.startsWith('>STATE:')) {
      const state = line.slice('>STATE:'.length).split(',')[1]
      if (state === 'CONNECTED') setVpnStatus('connected')
      else if (state === 'EXITING') setVpnStatus('disconnected')
      else if (state) setVpnStatus('connecting')
    } else if (line.startsWith('>FATAL:')) {
      setVpnStatus('error', line.slice('>FATAL:'.length).trim())
    }
  }
}

async function cleanupVpnTempDir(): Promise<void> {
  if (vpnRuntime.tempDir) {
    await rm(vpnRuntime.tempDir, { recursive: true, force: true }).catch(() => {})
    vpnRuntime.tempDir = null
  }
  // Called on every path that means "no longer this process's problem to clean up" (a failed
  // connect, a clean disconnect, the management socket closing on its own) — so clearing the
  // orphan-recovery record here too, rather than at each call site individually, keeps it from
  // ever going stale while a connection this same process knows is already gone.
  vpnRecoveryService.clearSession()
}

// macOS's TCC privacy protection blocks a root process spawned via sudo-prompt's elevated
// AppleScript "administrator privileges" mechanism from reading files under the user's
// Desktop/Documents/Downloads — confirmed live: the exact same config and binary, invoked the
// exact same way, fails with "Error opening configuration file" from that location but connects
// fine once copied elsewhere. Root normally bypasses Unix permission bits, but TCC is a separate
// check macOS enforces regardless of UID, specifically so sudo/root can't be used to route around
// it. Copying the config (and whatever ca/cert/key/etc. files it references by relative path)
// into the per-connection temp dir — already proven reachable under this same elevation — sidesteps
// the restriction regardless of where the user's original .ovpn file happens to live.
// Resolves `relativePath` under `baseDir`, refusing anything that would land outside it
// (e.g. a .ovpn file's own "ca ../../../../etc/passwd" directive) rather than trusting the
// config's author — a .ovpn is exactly the kind of file people import from strangers/community
// sources, so treat its directive arguments as untrusted input, not just a filename to join.
function safeJoin(baseDir: string, relativePath: string): string | null {
  const resolvedBase = join(baseDir)
  const target = join(baseDir, relativePath)
  // path.join() uses backslashes on Windows — a hardcoded '/' here silently rejected every
  // legitimate relative reference on that platform (confirmed live: ca/cert/key never got
  // copied, OpenVPN then failed with "cannot find ca.crt" even though --cd pointed at the
  // right directory), since the real target path never "starts with" resolvedBase + '/' there.
  if (target !== resolvedBase && !target.startsWith(resolvedBase + sep)) return null
  return target
}

async function importVpnConfigInto(destDir: string, originalConfigPath: string): Promise<string> {
  const originalDir = dirname(originalConfigPath)
  const content = await readFile(originalConfigPath, 'utf8')
  const referencedFileDirectives = ['ca', 'cert', 'key', 'dh', 'tls-auth', 'tls-crypt', 'pkcs12', 'crl-verify']
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const [directive, ...rest] = trimmed.split(/\s+/)
    if (!referencedFileDirectives.includes(directive)) continue
    const rawArg = rest[0]?.replace(/^["']|["']$/, '').replace(/["']$/, '')
    if (!rawArg || isAbsolute(rawArg)) continue
    const sourcePath = safeJoin(originalDir, rawArg)
    const destPath = sourcePath ? safeJoin(destDir, rawArg) : null
    if (sourcePath && destPath && existsSync(sourcePath)) await copyFile(sourcePath, destPath)
  }
  const destConfigPath = join(destDir, basename(originalConfigPath))
  await copyFile(originalConfigPath, destConfigPath)
  return destConfigPath
}

async function assertNoSymlinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to import: "${entry.name}" is a symlink, which isn't supported for security reasons.`)
    }
    if (entry.isDirectory()) await assertNoSymlinks(entryPath)
  }
}

// extract-zip has a known, currently-unfixed vulnerability (GHSA-jmr9-qjv8-65gv): a maliciously
// crafted zip containing a symlink can write files outside the intended destination directory.
// A VPN config bundle is exactly the kind of file people download from third-party/community
// sources, so this isn't a theoretical concern — verify no symlink made it into the extracted
// tree (a legitimate OpenVPN config bundle never needs one) and refuse the whole import if so,
// rather than trusting the library's own containment.
async function extractVpnConfigZip(zipPath: string, destDir: string): Promise<void> {
  await extractZip(zipPath, { dir: destDir })
  await assertNoSymlinks(destDir)
}

async function findOvpnFile(dir: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findOvpnFile(entryPath)
      if (found) return found
    } else if (extname(entry.name).toLowerCase() === '.ovpn') {
      return entryPath
    }
  }
  return null
}

// Imports a user-picked .ovpn file (or a .zip bundle containing one, alongside its ca/cert/key
// files — the format most real-world VPN providers actually distribute) into a directory this
// app owns under userData, rather than referencing the original location in place. This avoids
// two real problems: the original file moving/being deleted later, and macOS's TCC blocking the
// elevated connect step from ever reading it if it happens to live under Desktop/Documents/
// Downloads (see importVpnConfigInto's own comment) — importing up front means the connect-time
// copy always reads from a location this app controls, not wherever the user happened to pick.
async function importPickedVpnConfig(pickedPath: string): Promise<string> {
  let sourceOvpnPath = pickedPath
  let zipStagingDir: string | null = null
  try {
    if (extname(pickedPath).toLowerCase() === '.zip') {
      zipStagingDir = await mkdtemp(join(tmpdir(), 'allisoniptv-vpn-zip-'))
      await extractVpnConfigZip(pickedPath, zipStagingDir)
      const found = await findOvpnFile(zipStagingDir)
      if (!found) throw new Error('No .ovpn file found inside that zip.')
      sourceOvpnPath = found
    }
    const destDir = join(app.getPath('userData'), 'vpn-profiles', randomUUID())
    await mkdir(destDir, { recursive: true })
    return await importVpnConfigInto(destDir, sourceOvpnPath)
  } finally {
    if (zipStagingDir) await rm(zipStagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Every IPv4 address `hostname` currently resolves to, in resolver order, de-duplicated and
 * capped. Falls back to the plain single-address lookup if the all-addresses form fails, so a
 * resolver that refuses the option degrades to this app's previous behaviour instead of failing
 * the connect.
 *
 * IPv4 only: the route lines this feeds are IPv4-syntax on every platform. A host that resolves
 * to nothing else now fails the connect loudly (see startVpn) rather than writing a route line
 * that couldn't express it.
 */
async function resolveRouteAddresses(hostname: string): Promise<string[]> {
  try {
    const addresses = await dnsLookup(hostname, { all: true, family: 4 })
    const usable = normalizeRouteIps(addresses.map((entry) => entry.address))
    if (usable.length > 0) return usable
  } catch {
    // Fall through to the single-address form below.
  }
  try {
    const { address } = await dnsLookup(hostname)
    return normalizeRouteIps([address])
  } catch {
    return []
  }
}

async function startVpn(
  configPath: string,
  username: string | null,
  password: string | null,
  xtreamServerUrl: string
): Promise<void> {
  if (vpnRuntime.status === 'connecting' || vpnRuntime.status === 'connected') return
  setVpnStatus('connecting')
  try {
    const openvpnPath = await findOpenvpnBinary()
    const xtreamHost = new URL(xtreamServerUrl).hostname
    vpnRuntime.tunneledHost = xtreamHost.toLowerCase()
    // Every address, not just the first — a panel behind several A records would otherwise have
    // most of its traffic quietly riding the normal default route while the UI showed the VPN as
    // on. Failing here is deliberate: connecting without routing the provider would look like it
    // worked.
    const xtreamIps = await resolveRouteAddresses(xtreamHost)
    if (xtreamIps.length === 0) {
      throw new Error(`Could not resolve ${xtreamHost} to an address to route through the tunnel`)
    }
    vpnRuntime.tunneledIps = xtreamIps
    const originalGateway = await getDefaultGateway()
    const dir = await mkdtemp(join(tmpdir(), 'allisoniptv-vpn-'))
    vpnRuntime.tempDir = dir
    const importedConfigPath = await importVpnConfigInto(dir, configPath)
    const routeUpScript = await writeRouteScript(dir, 'route-up', xtreamIps, 'add', originalGateway)
    // OpenVPN has no "--route-down" option — the flag that runs a command before routes are
    // torn down is "--route-pre-down". Using a nonexistent flag makes OpenVPN reject the whole
    // command line at option-parsing time ("Unrecognized option... route-down") and exit
    // immediately, which surfaces to the renderer as a content-free "Command failed" error.
    const routePreDownScript = await writeRouteScript(dir, 'route-pre-down', xtreamIps, 'delete', originalGateway)
    const managementPort = await findFreeLocalPort()
    const logPath = join(dir, 'openvpn.log')
    // Recorded before openvpn is even spawned (not after a successful connect) so a crash at any
    // point from here onward is still recoverable at next launch — terminateOrphanedSession
    // treats "nothing listening on this port" as "already gone, nothing to clean up" either way,
    // so recording early costs nothing if this attempt never actually gets OpenVPN running at all.
    vpnRecoveryService.recordSession({ managementPort, tempDir: dir })

    // --script-security 2 is required for OpenVPN to run the route-up/route-pre-down scripts
    // at all — the default (1) only allows built-in executables, not user-defined scripts.
    const isWindows = process.platform === 'win32'
    const openvpnInvocation = [
      quoteArg(openvpnPath),
      '--config',
      quoteArg(importedConfigPath),
      // The config and any relative ca/cert/key files it references were just copied into
      // `dir` by importVpnConfigInto — --cd points here (not the original file's own
      // directory) so relative references resolve regardless of where the user's original
      // .ovpn lives, and regardless of what cwd the elevated shell happens to start in.
      '--cd',
      quoteArg(dir),
      '--route-nopull',
      '--script-security',
      '2',
      '--route-up',
      quoteArg(routeUpScript),
      '--route-pre-down',
      quoteArg(routePreDownScript),
      '--management',
      '127.0.0.1',
      String(managementPort),
      '--management-query-passwords',
      // OpenVPN's Windows build has no --daemon support at all (confirmed live: "daemon()
      // failed or unsupported: Bad address", immediate fatal exit) — there's no fork()/
      // daemonize model on Windows to begin with. --daemon is POSIX-only here; on Windows
      // the whole invocation is instead wrapped in `start /B` below, which is what actually
      // detaches the process there.
      ...(isWindows ? [] : ['--daemon']),
      '--log',
      quoteArg(logPath)
    ].join(' ')
    // sudo-prompt's Windows elevation path runs our command inside a .bat file and waits for
    // it to exit before ever reporting back — with no --daemon to make openvpn.exe return
    // immediately, that wait would never end. `start "" /B` launches it as a genuinely separate
    // process (not one cmd.exe blocks on) so the .bat completes right away while openvpn.exe
    // keeps running. The empty "" is required: start's first quoted argument is always taken
    // as a window title, not the command, if omitted.
    const command = isWindows ? `start "" /B ${openvpnInvocation}` : openvpnInvocation

    await new Promise<void>((resolve, reject) => {
      // sudo-prompt's callback is (error, stdout, stderr) — a bad OpenVPN flag or a config
      // error surfaces here as a non-zero exit, and stderr is normally OpenVPN's own plain-
      // English explanation of why. sudo-prompt's own `error.message` is just "Command
      // failed: <the whole command line>", so without this the real reason is silently lost.
      sudoExec(command, { name: 'AllisonIPTV' }, (error, stdout, stderr) => {
        if (error) {
          const detail = [stderr, stdout].map((s) => (typeof s === 'string' ? s.trim() : '')).find((s) => s.length > 0)
          reject(detail ? new Error(detail) : error)
        } else {
          resolve()
        }
      })
    })

    await connectManagementInterface(managementPort, username, password)
  } catch (err) {
    // The --log file can hold OpenVPN's own diagnostics even when sudo-prompt's stdout/stderr
    // came back empty (e.g. it wrote its explanation there before the process exited) — read
    // it before cleanupVpnTempDir() deletes the whole temp directory out from under us.
    let message = err instanceof Error ? err.message : String(err)
    const logPath = vpnRuntime.tempDir ? join(vpnRuntime.tempDir, 'openvpn.log') : null
    if (logPath) {
      const log = await readFile(logPath, 'utf8').catch(() => null)
      if (log?.trim()) message += `\n\nOpenVPN log:\n${log.trim()}`
    }
    setVpnStatus('error', message)
    await cleanupVpnTempDir()
  }
}

async function stopVpn(): Promise<void> {
  const socket = vpnRuntime.managementSocket
  if (socket && !socket.destroyed) {
    socket.write('signal SIGTERM\n')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000)
      socket.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
  setVpnStatus('disconnected')
  await cleanupVpnTempDir()
}

/**
 * Xtream Codes panels are built for native players (VLC, set-top boxes) and never send
 * CORS headers, so Chromium blocks every player_api/EPG/stream request as cross-origin.
 * This proxy re-issues each request from the main process (not subject to browser CORS)
 * and stamps the response with permissive CORS headers before handing it to the renderer.
 * `proxyTargetBase` is swapped whenever the user connects to a (possibly different) profile.
 * The actual request-handling logic (retry/timeout, header rewriting, off-tunnel-redirect
 * detection) lives in proxyServer.ts, decoupled from Electron entirely, so it can be unit-
 * tested against a real local HTTP server — see src/main/proxyServer.test.ts.
 */
let proxyTargetBase: string | null = null

function startLocalProxy(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createProxyServer({
      getProxyTargetBase: () => proxyTargetBase,
      // 'manual' (not 'follow') so proxyServer.ts's own 'redirect' listener gets a chance to
      // see every hop's target host before it's taken — 'follow' resolves them invisibly,
      // which is exactly how a provider redirecting stream delivery to an off-tunnel CDN host
      // could go unnoticed while the VPN is meant to be covering all of it (see the VPN
      // section of ROADMAP.md). Every redirect is still followed either way; this only adds
      // visibility, it doesn't block anything.
      // Cast is a TypeScript limitation, not a real gap: Electron's ClientRequest genuinely
      // declares 'response'/'redirect'/'abort' with matching signatures (checked directly in
      // electron.d.ts), but assigning a type with as many overloaded .on() event names as
      // ClientRequest has to an interface expecting only a handful of them trips up TS's
      // overload-set assignability check even though every individual overload actually
      // matches.
      createUpstreamRequest: ({ method, url }) =>
        net.request({ method, url, redirect: 'manual' }) as unknown as UpstreamClientRequest,
      clearHostResolverCache: () => session.defaultSession.clearHostResolverCache(),
      isVpnConnected: () => vpnRuntime.status === 'connected',
      getVpnTunneledHost: () => vpnRuntime.tunneledHost,
      onOffTunnelRedirect: (tunneledHost, redirectHost) => {
        if (warnedOffTunnelHosts.has(redirectHost)) return
        warnedOffTunnelHosts.add(redirectHost)
        console.warn(`[vpn] proxied request redirected off the tunneled host: ${tunneledHost} -> ${redirectHost}`)
        mainWindowRef?.webContents.send('vpn:stream-route-warning', {
          message: `A request was redirected to ${redirectHost}, which isn't routed through the VPN — only ${tunneledHost} is. That traffic may be bypassing the tunnel.`
        })
      },
      getVpnTunneledIps: () => vpnRuntime.tunneledIps,
      resolveHostIp: async (hostname) => {
        try {
          return (await dnsLookup(hostname)).address
        } catch {
          return null
        }
      },
      onTunneledHostIpChanged: (tunneledHost, tunneledIps, resolvedIp) => {
        if (warnedTunnelIpChanges.has(resolvedIp)) return
        warnedTunnelIpChanges.add(resolvedIp)
        console.warn(`[vpn] ${tunneledHost} now resolves to ${resolvedIp}, but the VPN routes only ${tunneledIps.join(', ')}`)
        mainWindowRef?.webContents.send('vpn:stream-route-warning', {
          // Names the fix, because there is one: re-adding routes needs root, so the only honest
          // way to cover a *later* DNS answer is to bring the tunnel up again — which re-runs the
          // route-up script against whatever the host resolves to now. VpnWarnings offers exactly
          // that as a button.
          message: `${tunneledHost} now resolves to ${resolvedIp}, which the VPN isn't routing — traffic to it may be bypassing the tunnel. Reconnecting the VPN will route the address it resolves to now.`
        })
      },
      handleTranscodeRequest: (url, res) => void transcodeService.serveTranscodeFile(url, res)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

// Packaged builds get their icon baked in by electron-builder (from build/icon.png) at the OS
// level — an .icns/.ico embedded in the app bundle/exe — so this path only needs to resolve
// for the unpackaged dev app, which otherwise falls back to Electron's own default icon.
// Linux is the one platform where a runtime icon still matters packaged: many X11/Wayland
// window managers source the taskbar/alt-tab icon from the window itself rather than the
// AppImage's desktop entry (especially without desktop integration), so the same icon also
// ships as an extraResource (see build.linux in package.json) and is set on every window.
const devIconPath = join(__dirname, '../../build/icon.png')

function resolveWindowIconPath(): string | undefined {
  if (process.platform === 'linux') {
    const packagedPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : devIconPath
    return existsSync(packagedPath) ? packagedPath : undefined
  }
  // macOS/Windows: the bundle/exe icon covers the packaged case; only dev needs the explicit
  // path (verified behavior behind 0.4.3's original fix, which this generalizes for Linux).
  return is.dev && existsSync(devIconPath) ? devIconPath : undefined
}
const windowIconPath = resolveWindowIconPath()

// The About menu item needs to reach the renderer via IPC, but Menu.buildFromTemplate's click
// handler has no direct reference to whichever BrowserWindow is currently focused — captured
// here instead of threading it through, since this app only ever has one window at a time.
let mainWindowRef: BrowserWindow | null = null

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    title: 'AllisonIPTV',
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindowRef = mainWindow
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // On Windows/Linux, entering fullscreen should completely suppress the menu bar so it
  // doesn't intercept or steal mouse events near the top edge of the screen.
  mainWindow.on('enter-full-screen', () => {
    mainWindow.setMenuBarVisibility(false)
    // The *window* being fullscreen is invisible to the renderer's `document.fullscreenElement`
    // — the page has no idea it happened. Reported live as "it went into fullscreen by itself and
    // the exit button did nothing at all". Logging it here means that event is at least recorded
    // (the log is the first place to look when someone says the app did something on its own), and
    // the renderer is told so its own fullscreen control can offer to leave this too.
    logLifecycle('window entered native fullscreen')
    mainWindow.webContents.send('window:full-screen-changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow.setMenuBarVisibility(false)
    logLifecycle('window left native fullscreen')
    mainWindow.webContents.send('window:full-screen-changed', false)
  })

  // HTML fullscreen (the player's own fullscreen, via the Fullscreen API) is a different thing
  // again, and equally invisible from here — recorded for the same reason.
  mainWindow.webContents.on('enter-html-full-screen', () => logLifecycle('player entered fullscreen (html)'))
  mainWindow.webContents.on('leave-html-full-screen', () => logLifecycle('player left fullscreen (html)'))

  // A renderer that has died leaves a blank window — and, if it died while fullscreen, a blank
  // *fullscreen* window whose controls are all dead, which is exactly the trap reported live
  // ("stuck in fullscreen, had to close the window"). Record it, get the window out of fullscreen
  // so it is escapable, and reload once so the app recovers by itself rather than needing a
  // force-quit. A repeat within CRASH_RELOAD_SUPPRESSION_MS is a real fault, not a blip: it is
  // logged and left visible rather than reloaded in a loop.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logLifecycle(
      `renderer process gone — reason=${details.reason} exitCode=${details.exitCode}`
    )
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
    if (mainWindow.isDestroyed()) return
    const now = Date.now()
    if (now - lastCrashReloadAt < CRASH_RELOAD_SUPPRESSION_MS) {
      logLifecycle('renderer crashed again too soon — not reloading automatically')
      return
    }
    lastCrashReloadAt = now
    logLifecycle('reloading the renderer after the crash')
    try {
      mainWindow.webContents.reload()
    } catch (err) {
      logLifecycle(`reload after crash failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  mainWindow.webContents.on('unresponsive', () => logLifecycle('renderer unresponsive'))
  mainWindow.webContents.on('responsive', () => logLifecycle('renderer responsive again'))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url).catch((err) => console.error('[main] failed to open external URL:', err))
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow
      .loadURL(process.env['ELECTRON_RENDERER_URL'])
      .catch((err) => console.error('[main] failed to load dev server URL:', err))
  } else {
    mainWindow
      .loadFile(join(__dirname, '../renderer/index.html'))
      .catch((err) => console.error('[main] failed to load packaged renderer:', err))
  }
}

// A custom click handler (not role: 'about') so the panel is a renderer-side modal showing the
// buildNumber field too — the native macOS About panel (role: 'about') has no slot for that.
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const openAbout = (): void => mainWindowRef?.webContents.send('menu:open-about')
  const aboutItem: MenuItemConstructorOptions = { label: `About ${app.getName()}`, click: openAbout }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.getName(),
            submenu: [
              aboutItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: isMac ? [] : [aboutItem] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  // A rejected second instance already called app.quit() above, but that alone doesn't stop the
  // rest of this synchronous setup from running before the quit sequence actually completes —
  // without this guard, a second instance would still reach vpnRecoveryService's
  // terminateOrphanedSession() and could tear down the first instance's own live, legitimate VPN
  // connection out from under it (both processes share the same on-disk recovery record). See
  // requestSingleInstanceLock's own comment at the top of this file.
  if (!gotSingleInstanceLock) return
  electronApp.setAppUserModelId('com.iptv.app')
  buildAppMenu()

  // BrowserWindow's `icon` option only affects Windows/Linux — macOS Dock icon has to be set
  // separately, and only matters in dev, since the packaged .app bundle carries its own icns.
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(devIconPath))
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // The renderer's fullscreen control needs to know about the *window* being fullscreen as well
  // as the page (see the enter-full-screen handler above). Nothing here can enter native
  // fullscreen — only leave it — which is deliberate: the app never puts its own window into
  // macOS's fullscreen mode, it only offers a way out when the OS does.
  ipcMain.handle('app:is-full-screen', () => mainWindowRef?.isFullScreen() ?? false)
  ipcMain.handle('app:exit-full-screen', () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return
    if (!mainWindowRef.isFullScreen()) return
    logLifecycle('renderer asked to leave native fullscreen')
    mainWindowRef.setFullScreen(false)
  })

  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    buildNumber: pkgMeta.buildNumber
  }))

  ipcMain.handle('store:get', (_event, key: string) => store.get(key))
  ipcMain.handle('store:set', (_event, key: string, value: unknown) => store.set(key, value))
  ipcMain.handle('store:delete', (_event, key: string) => store.delete(key))
  ipcMain.handle('notification:show', (_event, title: string, body: string) => {
    new Notification({ title, body }).show()
  })

  // Exports every BACKUP_KEYS entry into one JSON file the user picks a location for — a plain
  // native Save dialog rather than anything auto-triggered, since this is meant for a deliberate
  // "back this up before I reinstall/move machines" moment, not a background behavior. Returns
  // null (not an error) on cancel, matching vpn:selectConfigFile's own convention below.
  ipcMain.handle('backup:export', async () => {
    if (!mainWindowRef) return null
    const result = await dialog.showSaveDialog(mainWindowRef, {
      title: 'Export Backup',
      defaultPath: `allisoniptv-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    const data: Record<string, unknown> = {}
    for (const key of BACKUP_KEYS) data[key] = store.get(key)
    const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), appVersion: app.getVersion(), data }
    await writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return result.filePath
  })

  // Only ever touches BACKUP_KEYS, regardless of what else a hand-edited or foreign file might
  // contain — this is a restore, not an arbitrary config merge. Deliberately overwrites rather
  // than merging (a real "backup/restore," matching what a user picking a specific backup file
  // actually expects) — the renderer reloads the whole app after a successful import so every
  // store field derived from these keys (profiles, favorites, settings, ...) picks the new
  // values up the same way a fresh launch would, rather than trying to patch already-initialized
  // in-memory state field by field.
  ipcMain.handle('backup:import', async () => {
    if (!mainWindowRef) return { imported: false as const }
    const result = await dialog.showOpenDialog(mainWindowRef, {
      title: 'Import Backup',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return { imported: false as const }
    const raw = await readFile(result.filePaths[0], 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('That file is not valid JSON.')
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('data' in parsed) ||
      typeof (parsed as { data: unknown }).data !== 'object' ||
      (parsed as { data: unknown }).data === null
    ) {
      throw new Error("That file doesn't look like an AllisonIPTV backup.")
    }
    const { data } = parsed as { data: Record<string, unknown> }
    for (const key of BACKUP_KEYS) {
      if (key in data) store.set(key, data[key])
    }
    return { imported: true as const }
  })

  // OS-keychain-backed encryption (macOS Keychain / Windows DPAPI / Linux Secret Service where
  // available) for the parental PIN — only reachable from the main process, hence the IPC
  // round-trip rather than something storage.ts could do directly. isAvailable() can be false
  // on Linux without a keyring daemon running; callers fall back to plaintext in that case,
  // same as before this existed.
  ipcMain.handle('safeStorage:isAvailable', () => safeStorage.isEncryptionAvailable())
  ipcMain.handle('safeStorage:encrypt', (_event, plainText: string) =>
    safeStorage.encryptString(plainText).toString('base64')
  )
  ipcMain.handle('safeStorage:decrypt', (_event, base64: string) =>
    safeStorage.decryptString(Buffer.from(base64, 'base64'))
  )

  const proxyPort = await startLocalProxy()
  ipcMain.handle('proxy:getBaseUrl', () => `http://127.0.0.1:${proxyPort}`)
  ipcMain.handle('proxy:setTarget', (_event, baseUrl: string) => {
    proxyTargetBase = baseUrl
  })

  ipcMain.handle(
    'transcode:start',
    async (
      _event,
      sourceUrl: string,
      isVod: boolean,
      sessionId: string,
      subtitleStreamIndex?: number,
      audioStreamIndex?: number
    ) => {
      // playlistPath's filename varies: usually playlist.m3u8, but master.m3u8 when
      // startTranscode detected and included a subtitle rendition (see transcodeService.ts) —
      // basename() rather than a hardcoded name is what makes that switch actually reach the
      // player. subtitleTracks passes through so the renderer can offer switching to a
      // different one (see useTranscodeFallback.ts's switchSubtitleTrack).
      const { playlistPath, subtitleTracks } = await transcodeService.startTranscode(
        sourceUrl,
        isVod,
        sessionId,
        subtitleStreamIndex,
        audioStreamIndex
      )
      return {
        sessionId,
        url: `http://127.0.0.1:${proxyPort}/__transcode/${sessionId}/${basename(playlistPath)}`,
        subtitleTracks
      }
    }
  )
  ipcMain.handle('transcode:stop', (_event, sessionId: string) => transcodeService.stopTranscode(sessionId))
  ipcMain.handle('transcode:probeTracks', (_event, sourceUrl: string) => transcodeService.probeTracks(sourceUrl))
  // The renderer re-sends its current watching state whenever playback starts, pauses, errors,
  // or stops (Player.tsx's keep-awake effect) — idempotent on both ends, so a lost or duplicate
  // message can never stack blockers or leave one dangling.
  ipcMain.handle('keepAwake:setEnabled', (_event, enabled: boolean) => {
    keepAwakeService.setEnabled(enabled)
    return keepAwakeService.isActive()
  })

  ipcMain.handle('vpn:selectConfigFile', async () => {
    if (!mainWindowRef) return null
    // Most real-world providers distribute a .ovpn alongside separate ca/cert/key files bundled
    // in a .zip (this app's own test config included) rather than a single self-contained file.
    const result = await dialog.showOpenDialog(mainWindowRef, {
      title: 'Select OpenVPN configuration file',
      filters: [{ name: 'OpenVPN config (.ovpn or .zip)', extensions: ['ovpn', 'zip'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return importPickedVpnConfig(result.filePaths[0])
  })
  ipcMain.handle(
    'vpn:connect',
    async (_event, configPath: string, username: string | null, password: string | null) => {
      if (!proxyTargetBase) throw new Error('Connect to an Xtream server before enabling the VPN')
      // startVpn reports failure via setVpnStatus (pushed to the renderer as vpn:status-changed)
      // rather than throwing, since most of what it does happens after this call would already
      // need to have returned (the management interface keeps running long after). But that
      // means this handler resolving successfully doesn't actually mean the connection
      // succeeded — checking the resulting status and throwing here too keeps the two paths
      // (awaiting this call vs. listening for the status event) in agreement instead of one
      // saying "done" while the other says "failed".
      await startVpn(configPath, username, password, proxyTargetBase)
      if (vpnRuntime.status === 'error') {
        throw new Error(vpnRuntime.errorMessage ?? 'Failed to connect')
      }
    }
  )
  ipcMain.handle('vpn:disconnect', () => stopVpn())
  ipcMain.handle('vpn:getStatus', () => ({ status: vpnRuntime.status, errorMessage: vpnRuntime.errorMessage }))
  ipcMain.handle('vpn:openLog', async () => {
    // vpnRuntime.tempDir (and the log file in it) only exists for the current connection
    // attempt — cleaned up on disconnect or on a startVpn() failure, so there's nothing to open
    // once the attempt is fully over. Genuinely useful mid-attempt though: a tunnel stuck
    // reconnecting (e.g. the real DNS-sinkhole case found during testing) keeps its process —
    // and its live-growing log — running the whole time, which the error message alone doesn't
    // capture since there's no terminal error yet to attach it to.
    if (!vpnRuntime.tempDir) return { ok: false, message: 'No active VPN connection to show a log for.' }
    const logPath = join(vpnRuntime.tempDir, 'openvpn.log')
    if (!existsSync(logPath)) return { ok: false, message: 'Log file not written yet — try again in a moment.' }
    const error = await shell.openPath(logPath)
    return error ? { ok: false, message: error } : { ok: true }
  })
  ipcMain.handle('vpn:removeImportedConfig', async (_event, configPath: string) => {
    // Only ever delete inside our own vpn-profiles import directory — a profile added before
    // this import-on-add behavior existed can still have configPath pointing anywhere the user
    // originally picked (e.g. their own Desktop folder), and removing that profile must never
    // touch the user's own files.
    const importsRoot = join(app.getPath('userData'), 'vpn-profiles')
    const configDir = dirname(configPath)
    if (dirname(configDir) === importsRoot) {
      await rm(configDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // Before the window ever appears — see vpnRecoveryService.ts's own doc comment for why this is
  // safe and necessary even though this fresh process never itself started a VPN connection.
  await vpnRecoveryService.terminateOrphanedSession()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Checks the GitHub Releases this app's CI publishes to (see .github/workflows/release.yml
  // and the "publish" field in package.json) — a no-op until the app is actually packaged
  // and code-signed, since autoUpdater has nothing to check against in dev and unsigned
  // installs can download but not silently apply an update (macOS in particular refuses to
  // apply one at all without notarization — see ROADMAP.md).
  //
  // autoDownload is off deliberately: checkForUpdatesAndNotify() (the one-liner this replaces)
  // downloads the moment it finds a newer version and only ever surfaces Electron's own native
  // OS notification, with no way to ask first or show progress. Driving updater.on(...) events
  // into the renderer instead (below) lets the UI offer an actual "Update now / Later" prompt
  // and only spend the user's bandwidth once they've said yes.
  autoUpdater.autoDownload = false
  autoUpdater.on('update-available', (info) => {
    mainWindowRef?.webContents.send('update:available', {
      version: info.version,
      // This release's notes (generated from ROADMAP.md at build time — see
      // scripts/extract-release-notes.mjs, which electron-builder embeds in the update feed).
      // electron-updater hands a YAML feed's notes over as a string; richer providers can return
      // an array, which this deliberately ignores rather than half-rendering.
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    })
  })
  autoUpdater.on('download-progress', (progress) => {
    mainWindowRef?.webContents.send('update:progress', { percent: progress.percent })
  })
  autoUpdater.on('update-downloaded', (info) => {
    mainWindowRef?.webContents.send('update:downloaded', { version: info.version })
  })
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error:', err)
    mainWindowRef?.webContents.send('update:error', { message: err.message })
  })

  ipcMain.handle('update:check', () => autoUpdater.checkForUpdates())
  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate())
  // quitAndInstall() tears down the app itself — nothing after this call runs. The renderer
  // only ever calls this from an explicit "Restart now" click, never automatically.
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())

  // The launch-time check is triggered from the renderer's init() now (see useAppStore.ts),
  // not fired from here. Firing it this early, straight from main, raced webContents' own
  // load: if checkForUpdates() resolved (or update-available fired) before the page had
  // attached its ipcRenderer listener, the event was simply lost — send() doesn't queue for a
  // listener that isn't registered yet — so a real update could go unnoticed. Triggering it by
  // IPC from init(), after its listeners are already registered, removes that race and lets the
  // check gate the auto-connect step, per the request that the app check for an update before
  // connecting.
}).catch((err) => {
  console.error('[main] app initialization failed:', err)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Without this, quitting the app while a transcode is active would leave its ffmpeg child
// process (and temp directory) running/on-disk indefinitely — Electron doesn't kill child
// processes it didn't spawn via its own process-management APIs on quit. Same reasoning for an
// active VPN connection: OpenVPN was spawned via sudo-prompt, entirely outside Electron's own
// process tree, so quitting this app would otherwise leave the tunnel (and its route to the
// Xtream server) running indefinitely in the background with nothing left to use it.
//
// stopVpn() is genuinely async (it writes SIGTERM to OpenVPN's management socket, then waits up
// to 3s for the socket to actually close) — firing it without waiting, as this used to do, let
// Electron's own quit sequence race ahead and tear down the process before OpenVPN necessarily
// finished shutting the tunnel down. preventDefault() + re-quitting once stopVpn() resolves
// guarantees the tunnel is actually closed first; the `quitting` flag stops this same handler
// from preventing that second, deliberate app.quit() call from going through.
let quittingAfterVpnStop = false
app.on('before-quit', (event) => {
  transcodeService.stopAll()
  // Belt-and-braces: the renderer's keep-awake effect releases the blocker itself when
  // playback stops, but if the app quits mid-playback the renderer may never get that chance —
  // powerSaveBlocker would otherwise keep asserting display-sleep until process exit anyway,
  // and being explicit costs nothing.
  keepAwakeService.setEnabled(false)
  if (vpnRuntime.status !== 'disconnected' && !quittingAfterVpnStop) {
    event.preventDefault()
    quittingAfterVpnStop = true
    void stopVpn().finally(() => app.quit())
  }
})
