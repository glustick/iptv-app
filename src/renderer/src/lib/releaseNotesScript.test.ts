import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractVersionNotes } from '../../../../scripts/extract-release-notes.mjs'

// These cover the generator that feeds the update prompt's notes — including the CRLF case that
// really did ship a broken Windows update feed once (95KB of ROADMAP instead of one entry).
describe('extractVersionNotes', () => {
  const roadmap = [
    '# Roadmap',
    '',
    '- **0.1.0** the old one.',
    '',
    '- **0.2.0** the current one, with `code` in it.',
    '',
    "What's below is a fresh list, reflecting where things stand after 0.2.0.",
    '',
    '## Section',
    '',
    '- **A bullet that is not an entry** but looks like one.'
  ].join('\n')

  it('extracts just the matching version entry', () => {
    expect(extractVersionNotes(roadmap, '0.2.0')).toBe('the current one, with `code` in it.')
  })

  it('handles CRLF line endings the same way (the bug that broke a real release feed)', () => {
    const crlf = roadmap.replace(/\n/g, '\r\n')
    expect(extractVersionNotes(crlf, '0.2.0')).toBe('the current one, with `code` in it.')
  })

  it('stops at the next entry when the blank-line separator is missing', () => {
    const squashed = '- **0.2.0** first.\n- **0.1.0** second.'
    expect(extractVersionNotes(squashed, '0.2.0')).toBe('first.')
  })

  it('returns nothing for a version with no entry', () => {
    expect(extractVersionNotes(roadmap, '9.9.9')).toBe('')
  })

  it('caps an absurdly long body rather than publishing a monster feed entry', () => {
    const huge = `- **0.2.0** ${'x'.repeat(50_000)}\n\nend`
    expect(extractVersionNotes(huge, '0.2.0').length).toBe(6000)
  })
})

describe('the generator script itself', () => {
  it('writes a small, correct notes file for the current version, CRLF roadmap included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-notes-'))
    const roadmapPath = join(dir, 'ROADMAP.md')
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version
    writeFileSync(roadmapPath, `- **${version}** Something short.\n\nNext line.\n`, 'utf8')

    execFileSync('node', ['scripts/extract-release-notes.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, RELEASE_NOTES_ROADMAP: roadmapPath }
    })

    const written = readFileSync('build/release-notes.md', 'utf8')
    expect(written).toContain(`What's new in AllisonIPTV ${version}`)
    expect(written).toContain('Something short.')
    expect(written).not.toContain('Next line.')
    expect(written.length).toBeLessThan(500)
  })
})
