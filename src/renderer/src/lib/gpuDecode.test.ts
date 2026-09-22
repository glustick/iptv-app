import { describe, it, expect } from 'vitest'
import { describeGpuDecode } from './gpuDecode'

describe('describeGpuDecode', () => {
  it('names the GPU when hardware decoding is on — the answer a user actually wants', () => {
    expect(describeGpuDecode({ videoDecode: 'enabled', devices: ['NVIDIA GeForce RTX 3080 Ti'] })).toBe(
      'Hardware — NVIDIA GeForce RTX 3080 Ti'
    )
  })

  it('still says hardware when the platform reports no device name', () => {
    expect(describeGpuDecode({ videoDecode: 'enabled', devices: [] })).toBe('Hardware')
  })

  it('calls out the case that looks like a stream problem but is not: the CPU decoding', () => {
    expect(describeGpuDecode({ videoDecode: 'software', devices: ['NVIDIA GeForce RTX 3080 Ti'] })).toBe(
      'Software only (GPU decoding is unavailable)'
    )
  })

  it('reports a blocklisted or disabled GPU path rather than hiding it', () => {
    expect(describeGpuDecode({ videoDecode: 'blocklisted', devices: [] })).toBe(
      "Blocked by Chromium's GPU blocklist"
    )
    expect(describeGpuDecode({ videoDecode: 'disabled', devices: [] })).toBe('Disabled')
    expect(describeGpuDecode({ videoDecode: 'unavailable', devices: [] })).toBe('Unavailable')
  })

  it('returns nothing at all when there is no status — no row beats a made-up one', () => {
    expect(describeGpuDecode(null)).toBeNull()
    expect(describeGpuDecode(undefined)).toBeNull()
    expect(describeGpuDecode({ videoDecode: null, devices: [] })).toBeNull()
  })

  it('passes an unknown future status through verbatim instead of guessing', () => {
    expect(describeGpuDecode({ videoDecode: 'something-new', devices: [] })).toBe('something-new')
  })
})
