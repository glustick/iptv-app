// Generates build/release-notes.md from this version's ROADMAP entry, so both the GitHub release
// page and the app's own update prompt say what actually changed instead of only which number is
// out. electron-builder picks a `release-notes.md` sitting in its build-resources directory
// (build/) up automatically and embeds it in the update feed as `releaseNotes` (see its
// updateInfoBuilder), which is how it reaches the app.
//
// Deliberately never fails the build: if the version's entry can't be found (a docs-only commit
// between releases, a hand-edited package.json), it writes a generic line and carries on.
//
// Hard-won detail: line endings. GitHub's Windows runners check the repository out with CRLF, so
// a blank line there is `\r\n\r\n` — searching the raw text for `\n\n` finds nothing and the
// "cut at the next blank line" step silently degrades to "cut at end of file". That shipped once
// (0.7.79's Windows update feed carried 95KB of the rest of ROADMAP.md instead of one entry), so
// the text is normalized first, and the cut now has a fallback terminator plus a hard length cap
// so a future miss can't publish a monster feed again.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const MAX_BODY_CHARS = 6000

/**
 * The body of one version's ROADMAP entry, or '' when it isn't there. Exported so the vitest
 * suite can exercise it directly (including the CRLF case that caused a real published bug).
 */
export function extractVersionNotes(roadmapText, version) {
  const roadmap = roadmapText.replace(/\r\n/g, '\n')
  const marker = `- **${version}**`
  const start = roadmap.indexOf(marker)
  if (start < 0) return ''
  const from = start + marker.length
  // Primary terminator: the blank line that separates one entry from the next.
  let end = roadmap.indexOf('\n\n', from)
  if (end === -1) {
    // Fallbacks, in order of how close they keep us to "one entry": the marker line that follows
    // the status section, then the next entry's own bullet, then end of file.
    const candidates = [roadmap.indexOf('\nWhat', from), roadmap.indexOf('\n- **', from)].filter((i) => i !== -1)
    end = candidates.length > 0 ? Math.min(...candidates) : roadmap.length
  }
  return roadmap.slice(from, end).trim().slice(0, MAX_BODY_CHARS).trim()
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const roadmapPath = process.env.RELEASE_NOTES_ROADMAP ?? join(root, 'ROADMAP.md')

  let body = ''
  try {
    body = extractVersionNotes(readFileSync(roadmapPath, 'utf8'), version)
  } catch (err) {
    console.warn('[release-notes] could not read the roadmap:', err instanceof Error ? err.message : err)
  }
  if (!body) body = 'Maintenance release — see the repository ROADMAP.md for the full history.'

  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build/release-notes.md'), `What's new in AllisonIPTV ${version}\n\n${body}\n`, 'utf8')
  console.log(`[release-notes] wrote build/release-notes.md for ${version} (${body.length} chars)`)
}

// Only run when invoked as a script — the vitest suite imports the helper above without wanting
// the file written.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()
