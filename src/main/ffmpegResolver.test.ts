import { describe, it, expect, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import ffmpegStaticPath from 'ffmpeg-static'
import { findSystemFfmpeg, isFfmpegBinaryUsable, createFfmpegResolver, type FfmpegResolverDeps } from './ffmpegResolver'

function makeDeps(overrides: Partial<FfmpegResolverDeps> = {}): FfmpegResolverDeps {
  return {
    platform: 'darwin',
    fileExists: () => false,
    execFile: () => Promise.reject(new Error('not found')),
    ...overrides
  }
}

describe('findSystemFfmpeg', () => {
  it('returns the first common install location that exists, without touching execFile', async () => {
    const execFile = vi.fn()
    const deps = makeDeps({
      fileExists: (path) => path === '/usr/local/bin/ffmpeg',
      execFile
    })

    const result = await findSystemFfmpeg(deps)

    expect(result).toBe('/usr/local/bin/ffmpeg')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('falls back to a which/where lookup when no common location exists', async () => {
    const deps = makeDeps({
      fileExists: () => false,
      execFile: (path, args) => {
        expect(path).toBe('which')
        expect(args).toEqual(['ffmpeg'])
        return Promise.resolve({ stdout: '/opt/custom/ffmpeg\n' })
      }
    })

    expect(await findSystemFfmpeg(deps)).toBe('/opt/custom/ffmpeg')
  })

  it('uses "where" instead of "which" on Windows, and checks no hardcoded common locations', async () => {
    const fileExists = vi.fn()
    const deps = makeDeps({
      platform: 'win32',
      fileExists,
      execFile: (path) => {
        expect(path).toBe('where')
        return Promise.resolve({ stdout: 'C:\\tools\\ffmpeg.exe\r\n' })
      }
    })

    expect(await findSystemFfmpeg(deps)).toBe('C:\\tools\\ffmpeg.exe')
    expect(fileExists).not.toHaveBeenCalled()
  })

  it('returns null when nothing is found anywhere', async () => {
    expect(await findSystemFfmpeg(makeDeps())).toBeNull()
  })
})

describe('isFfmpegBinaryUsable', () => {
  it('trusts output starting with "ffmpeg version"', async () => {
    const deps = makeDeps({ execFile: () => Promise.resolve({ stdout: 'ffmpeg version 6.0 Copyright...' }) })
    expect(await isFfmpegBinaryUsable('/usr/bin/ffmpeg', deps)).toBe(true)
  })

  it('rejects output that does not look like a real ffmpeg version banner', async () => {
    const deps = makeDeps({ execFile: () => Promise.resolve({ stdout: 'command not found' }) })
    expect(await isFfmpegBinaryUsable('/usr/bin/ffmpeg', deps)).toBe(false)
  })

  it('rejects a path that fails to execute at all', async () => {
    const deps = makeDeps({ execFile: () => Promise.reject(new Error('EACCES')) })
    expect(await isFfmpegBinaryUsable('/usr/bin/ffmpeg', deps)).toBe(false)
  })

  // The one integration-style check here: confirms this actually works against a real ffmpeg
  // binary, not just against hand-shaped fake stdout — the exact bundled binary this app ships.
  it('recognizes the real bundled ffmpeg-static binary as usable', async () => {
    expect(ffmpegStaticPath).toBeTruthy()
    const realExecFile = promisify(execFile)
    const deps = makeDeps({ execFile: (path, args) => realExecFile(path, args) })

    expect(await isFfmpegBinaryUsable(ffmpegStaticPath as string, deps)).toBe(true)
  })
})

describe('createFfmpegResolver', () => {
  it('prefers a working system ffmpeg over the bundled path', async () => {
    const deps = makeDeps({
      fileExists: (path) => path === '/usr/local/bin/ffmpeg',
      execFile: () => Promise.resolve({ stdout: 'ffmpeg version 6.0' })
    })

    const resolve = createFfmpegResolver('/bundled/ffmpeg', deps)

    expect(await resolve()).toBe('/usr/local/bin/ffmpeg')
  })

  it('falls back to the bundled path when no system ffmpeg is found', async () => {
    const resolve = createFfmpegResolver('/bundled/ffmpeg', makeDeps())
    expect(await resolve()).toBe('/bundled/ffmpeg')
  })

  it('falls back to the bundled path when a system ffmpeg is found but fails the usability check', async () => {
    const deps = makeDeps({
      fileExists: (path) => path === '/usr/local/bin/ffmpeg',
      execFile: () => Promise.resolve({ stdout: 'not actually ffmpeg' })
    })

    const resolve = createFfmpegResolver('/bundled/ffmpeg', deps)

    expect(await resolve()).toBe('/bundled/ffmpeg')
  })

  it('returns null when there is neither a usable system ffmpeg nor a bundled path', async () => {
    const resolve = createFfmpegResolver(null, makeDeps())
    expect(await resolve()).toBeNull()
  })

  it('only resolves once, caching the result across repeated calls', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: 'ffmpeg version 6.0' })
    const deps = makeDeps({ fileExists: (path) => path === '/usr/local/bin/ffmpeg', execFile })
    const resolve = createFfmpegResolver('/bundled/ffmpeg', deps)

    await resolve()
    await resolve()
    await resolve()

    expect(execFile).toHaveBeenCalledTimes(1)
  })
})
