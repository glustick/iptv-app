/**
 * Turns a release's notes (markdown-ish prose straight out of ROADMAP.md) into something readable
 * in the update prompt, which renders plain text — no markdown renderer in this app, and pulling
 * one in for an update dialog would be absurd. Strips the emphasis/code markers, turns bullets
 * into a middot list, collapses runs of blank lines, and caps the length so a long release can't
 * turn the dialog into a wall. The GitHub release page still shows the untouched original.
 */
export function formatReleaseNotes(raw: string, maxChars = 1600): string {
  const cleaned = raw
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^-\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (cleaned.length <= maxChars) return cleaned
  // Cut at a sentence-ish boundary rather than mid-word, then mark it as truncated.
  const clipped = cleaned.slice(0, maxChars)
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('\n'))
  return `${(lastStop > maxChars * 0.6 ? clipped.slice(0, lastStop + 1) : clipped).trim()} …`
}
