// Generates build/release-notes.md from this version's ROADMAP entry, so both the GitHub release
// page and the app's own update prompt say what actually changed instead of only which number is
// out. electron-builder picks a `release-notes.md` sitting in its build-resources directory
// (build/) up automatically and embeds it in the update feed as `releaseNotes` (see its
// updateInfoBuilder), which is how it reaches the app.
//
// Deliberately never fails the build: if the version's entry can't be found (a docs-only commit
// between releases, a hand-edited package.json), it writes a generic line and carries on.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const marker = `- **${version}**`
let body = ''
try {
  const roadmap = readFileSync(join(root, 'ROADMAP.md'), 'utf8')
  const start = roadmap.indexOf(marker)
  if (start >= 0) {
    const end = roadmap.indexOf('\n\n', start)
    body = roadmap.slice(start, end === -1 ? undefined : end).slice(marker.length).trim()
  }
} catch (err) {
  console.warn('[release-notes] could not read ROADMAP.md:', err instanceof Error ? err.message : err)
}
if (!body) body = 'Maintenance release — see the repository ROADMAP.md for the full history.'

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build/release-notes.md'), `What's new in AllisonIPTV ${version}\n\n${body}\n`, 'utf8')
console.log(`[release-notes] wrote build/release-notes.md for ${version} (${body.length} chars)`)
