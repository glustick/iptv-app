import { describe, it, expect } from 'vitest'
import { formatReleaseNotes } from './releaseNotes'

describe('formatReleaseNotes', () => {
  it('strips markdown emphasis and code markers so the plain-text prompt reads cleanly', () => {
    expect(formatReleaseNotes('**Bold** and `code` here')).toBe('Bold and code here')
  })

  it('drops a heading marker only at the start of a line, never mid-sentence', () => {
    expect(formatReleaseNotes('# Heading\nthen # not-a-heading')).toBe('Heading\nthen # not-a-heading')
  })

  it('turns markdown bullets into a middot list and collapses blank-line runs', () => {
    expect(formatReleaseNotes('- one\n- two\n\n\n\nafter')).toBe('• one\n• two\n\nafter')
  })

  it('leaves short notes untouched', () => {
    expect(formatReleaseNotes('A small maintenance release.')).toBe('A small maintenance release.')
  })

  it('caps a long release at a sentence boundary and marks the truncation', () => {
    const long = `${'First sentence. '.repeat(200)}`
    const formatted = formatReleaseNotes(long, 200)
    expect(formatted.length).toBeLessThanOrEqual(201)
    expect(formatted.endsWith('…')).toBe(true)
    expect(formatted).toContain('First sentence.')
  })

  it('handles empty input without throwing', () => {
    expect(formatReleaseNotes('')).toBe('')
  })
})
