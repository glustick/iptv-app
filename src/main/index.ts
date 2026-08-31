import {
  app,
  shell,
  dialog,
  BrowserWindow,
  ipcMain,
  net,
  session,
  nativeImage,
  Menu,
  safeStorage,
  type MenuItemConstructorOptions
} from 'electron'
import { join, extname, dirname, basename, isAbsolute, sep } from 'path'
import { createServer } from 'http'
import { connect as netConnect, type Socket } from 'net'
import { URL } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, readdir, copyFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
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
  // The single IP address actually written into the OS route (see writeRouteScript) — resolved
  // once, at connect time, via this app's own dns.lookup, entirely independent of Chromium's own
  // DNS resolution for the proxy's actual requests. Kept so the proxy can tell whether a *fresh*
  // resolution of the same tunneled host later returns something the route no longer covers.
  tunneledIp: string | null
}

const vpnRuntime: VpnRuntimeState = {
  status: 'disconnected',
  errorMessage: null,
  managementSocket: null,
  managementBuffer: '',
  tempDir: null,
  tunneledHost: null,
  tunneledIp: null
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
    vpnRuntime.tunneledIp = null
    warnedOffTunnelHosts.clear()
    warnedTunnelIpChanges.clear()
  }
  mainWindowRef?.webContents.send('vpn:status-changed', { status, errorMessage })
}

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
  xtreamIp: string,
  action: 'add' | 'delete',
  originalGateway: string | null
): Promise<string> {
  const isWindows = process.platform === 'win32'
  const path = join(dir, isWindows ? `${name}.bat` : `${name}.sh`)
  let content: string
  if (action === 'delete') {
    // OpenVPN's own teardown removes whatever it installed itself (including the redirect-
    // gateway /1 routes) once the process exits — only the narrow route this app added
    // independently needs explicit removal here.
    content = isWindows
      ? `@echo off\r\nroute delete ${xtreamIp} mask 255.255.255.255 >nul 2>&1\r\n`
      : process.platform === 'darwin'
        ? `#!/bin/sh\n/sbin/route -n delete -host ${xtreamIp} "$route_vpn_gateway" 2>/dev/null\n`
        : `#!/bin/sh\nip route del ${xtreamIp}/32 via "$route_vpn_gateway" 2>/dev/null || route delete -host ${xtreamIp} gw "$route_vpn_gateway" 2>/dev/null\n`
  } else if (isWindows) {
    const restore = originalGateway
      ? `route delete 0.0.0.0 mask 128.0.0.0 >nul 2>&1\r\nroute delete 128.0.0.0 mask 128.0.0.0 >nul 2>&1\r\nroute add 0.0.0.0 mask 0.0.0.0 ${originalGateway} metric 1 >nul 2>&1\r\n`
      : ''
    content = `@echo off\r\n${restore}route add ${xtreamIp} mask 255.255.255.255 %route_vpn_gateway%\r\n`
  } else if (process.platform === 'darwin') {
    const restore = originalGateway
      ? `route -n delete -net 0.0.0.0/1 2>/dev/null\nroute -n delete -net 128.0.0.0/1 2>/dev/null\nroute -n add default ${originalGateway} 2>/dev/null\n`
      : ''
    content = `#!/bin/sh\n${restore}/sbin/route -n add -host ${xtreamIp} "$route_vpn_gateway"\n`
  } else {
    const restore = originalGateway
      ? `ip route del 0.0.0.0/1 2>/dev/null\nip route del 128.0.0.0/1 2>/dev/null\nip route replace default via ${originalGateway} 2>/dev/null\n`
      : ''
    content = `#!/bin/sh\n${restore}ip route add ${xtreamIp}/32 via "$route_vpn_gateway" 2>/dev/null || route add -host ${xtreamIp} gw "$route_vpn_gateway"\n`
  }
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
    const { address: xtreamIp } = await dnsLookup(xtreamHost)
    vpnRuntime.tunneledIp = xtreamIp
    const originalGateway = await getDefaultGateway()
    const dir = await mkdtemp(join(tmpdir(), 'allisoniptv-vpn-'))
    vpnRuntime.tempDir = dir
    const importedConfigPath = await importVpnConfigInto(dir, configPath)
    const routeUpScript = await writeRouteScript(dir, 'route-up', xtreamIp, 'add', originalGateway)
    // OpenVPN has no "--route-down" option — the flag that runs a command before routes are
    // torn down is "--route-pre-down". Using a nonexistent flag makes OpenVPN reject the whole
    // command line at option-parsing time ("Unrecognized option... route-down") and exit
    // immediately, which surfaces to the renderer as a content-free "Command failed" error.
    const routePreDownScript = await writeRouteScript(dir, 'route-pre-down', xtreamIp, 'delete', originalGateway)
    const managementPort = await findFreeLocalPort()
    const logPath = join(dir, 'openvpn.log')

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
      getVpnTunneledIp: () => vpnRuntime.tunneledIp,
      resolveHostIp: async (hostname) => {
        try {
          return (await dnsLookup(hostname)).address
        } catch {
          return null
        }
      },
      onTunneledHostIpChanged: (tunneledHost, tunneledIp, resolvedIp) => {
        if (warnedTunnelIpChanges.has(resolvedIp)) return
        warnedTunnelIpChanges.add(resolvedIp)
        console.warn(`[vpn] ${tunneledHost} now resolves to ${resolvedIp}, but the VPN route only covers ${tunneledIp}`)
        mainWindowRef?.webContents.send('vpn:stream-route-warning', {
          message: `${tunneledHost} now resolves to a different address (${resolvedIp}) than the one the VPN is routing (${tunneledIp}). Traffic to it may be bypassing the tunnel.`
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
const devIconPath = join(__dirname, '../../build/icon.png')

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
    ...(is.dev ? { icon: devIconPath } : {}),
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

  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    buildNumber: pkgMeta.buildNumber
  }))

  ipcMain.handle('store:get', (_event, key: string) => store.get(key))
  ipcMain.handle('store:set', (_event, key: string, value: unknown) => store.set(key, value))
  ipcMain.handle('store:delete', (_event, key: string) => store.delete(key))

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
    async (_event, sourceUrl: string, isVod: boolean, sessionId: string, subtitleStreamIndex?: number) => {
      // playlistPath's filename varies: usually playlist.m3u8, but master.m3u8 when
      // startTranscode detected and included a subtitle rendition (see transcodeService.ts) —
      // basename() rather than a hardcoded name is what makes that switch actually reach the
      // player. subtitleTracks passes through so the renderer can offer switching to a
      // different one (see useTranscodeFallback.ts's switchSubtitleTrack).
      const { playlistPath, subtitleTracks } = await transcodeService.startTranscode(
        sourceUrl,
        isVod,
        sessionId,
        subtitleStreamIndex
      )
      return {
        sessionId,
        url: `http://127.0.0.1:${proxyPort}/__transcode/${sessionId}/${basename(playlistPath)}`,
        subtitleTracks
      }
    }
  )
  ipcMain.handle('transcode:stop', (_event, sessionId: string) => transcodeService.stopTranscode(sessionId))

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

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Checks the GitHub Releases this app's CI publishes to (see .github/workflows/release.yml
  // and the "publish" field in package.json) — a no-op until the app is actually packaged
  // and code-signed, since autoUpdater has nothing to check against in dev and unsigned
  // installs can download but not silently apply an update.
  if (!is.dev) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[auto-update] check failed:', err)
    })
  }
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
  if (vpnRuntime.status !== 'disconnected' && !quittingAfterVpnStop) {
    event.preventDefault()
    quittingAfterVpnStop = true
    void stopVpn().finally(() => app.quit())
  }
})
