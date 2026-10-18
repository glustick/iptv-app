import { describe, expect, it } from 'vitest'
import { canDecodeAudioCodec, dolbyMseCodec } from './audioCodecSupport'

describe('canDecodeAudioCodec', () => {
  it('treats a stream with no declared audio codec as playable', () => {
    expect(canDecodeAudioCodec(undefined, () => false)).toBe(true)
    expect(canDecodeAudioCodec('', () => false)).toBe(true)
  })

  it('allows codecs every browser decodes without consulting the probe', () => {
    let asked = false
    const probe = (): boolean => {
      asked = true
      return false
    }
    expect(canDecodeAudioCodec('mp4a.40.2', probe)).toBe(true)
    expect(canDecodeAudioCodec('aac', probe)).toBe(true)
    expect(asked).toBe(false)
  })

  it('flags Dolby audio as undecodable when the browser has no support (the reported case)', () => {
    // Chrome: E-AC-3 audio is dropped silently -> this is what triggers the transcode switch.
    expect(canDecodeAudioCodec('ec-3', () => false)).toBe(false)
    expect(canDecodeAudioCodec('ac-3', () => false)).toBe(false)
  })

  it('leaves Dolby audio alone where the browser does support it', () => {
    // Safari can decode E-AC-3 — transcoding there would be wasted work.
    expect(canDecodeAudioCodec('ec-3', () => true)).toBe(true)
  })

  it('asks the probe with the right MSE codec string and fails closed on a throwing probe', () => {
    const asked: string[] = []
    canDecodeAudioCodec('ec-3,eac3', (mime) => {
      asked.push(mime)
      return true
    })
    canDecodeAudioCodec('ac-3', (mime) => {
      asked.push(mime)
      return true
    })
    expect(asked).toEqual(['audio/mp4;codecs="ec-3"', 'audio/mp4;codecs="ac-3"'])
    expect(
      canDecodeAudioCodec('ec-3', () => {
        throw new Error('MediaSource unavailable')
      })
    ).toBe(false)
  })

  it('maps codec spellings to the MSE string', () => {
    expect(dolbyMseCodec('ec-3')).toBe('ec-3')
    expect(dolbyMseCodec('eac3')).toBe('ec-3')
    expect(dolbyMseCodec('ac-3')).toBe('ac-3')
  })
})
