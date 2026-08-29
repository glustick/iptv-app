/**
 * Bundling `ffmpeg-static` is what grew the Windows installer from ~82MB to ~103MB (confirmed
 * in 0.4.8) — a system-installed ffmpeg, when one exists and actually works, is preferred at
 * runtime over the bundled copy so a user who already has ffmpeg elsewhere isn't running a
 * second redundant copy of it. The bundled binary still ships unconditionally regardless (this
 * doesn't shrink the installer itself) — removing it would mean the audio-fix transcode
 * fallback simply doesn't work for the (likely more common, especially on Windows) case of a
 * user with no system ffmpeg at all, which is a real regression traded for a size saving that
 * only some users would even see.
 *
 * No Electron dependency here on purpose (this only needs fs/child_process, both injected)
 * so it can be unit-tested directly rather than folded untestably into index.ts.
 */
export interface FfmpegResolverDeps {
  platform: NodeJS.Platform
  fileExists: (path: string) => boolean
  execFile: (path: string, args: string[]) => Promise<{ stdout: string }>
}

// Common install locations checked directly (not just PATH) for the same reason
// findOpenvpnBinary (src/main/index.ts) does: a macOS app launched from Finder/Dock doesn't
// inherit the PATH a shell's .zshrc/.bash_profile would have set up (Homebrew's
// /opt/homebrew/bin chief among them), so relying on PATH lookup alone would miss a real,
// working install.
export async function findSystemFfmpeg(deps: FfmpegResolverDeps): Promise<string | null> {
  const candidates =
    // No hardcoded guesses on Windows: unlike Homebrew/apt, there's no one conventional
    // install directory a user's ffmpeg would land in — it's normally just extracted
    // somewhere and added to PATH by hand, so the PATH lookup below is the only real signal.
    deps.platform === 'win32'
      ? []
      : [
          '/opt/homebrew/bin/ffmpeg', // Homebrew on Apple Silicon
          '/usr/local/bin/ffmpeg', // Homebrew on Intel Mac / many Linux installs
          '/usr/bin/ffmpeg' // apt/dnf on most Linux distros
        ]
  for (const candidate of candidates) {
    if (deps.fileExists(candidate)) return candidate
  }
  try {
    const { stdout } = await deps.execFile(deps.platform === 'win32' ? 'where' : 'which', ['ffmpeg'])
    const resolved = stdout.split('\n')[0]?.trim()
    if (resolved) return resolved
  } catch {
    // Not in any common location or on PATH — the caller falls back to the bundled copy.
  }
  return null
}

// A PATH/common-location hit only proves *something* exists there — not that it's a working,
// compatible ffmpeg build. A broken symlink, a wrapper script that fails without the right
// arguments, or a genuinely incompatible build (e.g. a minimal distro package missing codecs)
// would otherwise silently replace a binary this feature is already known to work with, for an
// optimization that was never load-bearing. `-version` is cheap and side-effect-free, and
// confirms it's at least a real, runnable ffmpeg.
export async function isFfmpegBinaryUsable(path: string, deps: FfmpegResolverDeps): Promise<boolean> {
  try {
    const { stdout } = await deps.execFile(path, ['-version'])
    return stdout.startsWith('ffmpeg version')
  } catch {
    return false
  }
}

// Resolved once and cached (not re-checked per transcode) — the system either has a working
// ffmpeg on this launch or it doesn't; nothing about that changes mid-session, and a `which`
// plus a `-version` spawn on every channel that needs the audio-fix fallback would be a real,
// pointless cost for something that never changes. Returns a function rather than a value so
// the (async) check only actually runs the first time it's needed, not at app startup.
export function createFfmpegResolver(bundledPath: string | null, deps: FfmpegResolverDeps): () => Promise<string | null> {
  let cached: string | null | undefined
  return async () => {
    if (cached !== undefined) return cached
    const systemPath = await findSystemFfmpeg(deps)
    if (systemPath && (await isFfmpegBinaryUsable(systemPath, deps))) {
      console.log(`[transcode] using system ffmpeg: ${systemPath}`)
      cached = systemPath
    } else {
      cached = bundledPath
    }
    return cached
  }
}
