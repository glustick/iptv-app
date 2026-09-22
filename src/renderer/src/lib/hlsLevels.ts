/**
 * Labels and sanity checks for HLS quality levels.
 *
 * Why this is a module rather than three template strings inline: this app's own provider has
 * never been observed serving more than one rendition per channel, so the quality selector below
 * cannot be exercised against real content here — which makes the little logic it does have
 * (what to call a level, and whether a level says anything at all) worth pinning by test. The
 * stats overlay needs the same judgement: on a flat single-rendition feed hls.js reports a level
 * with no dimensions and no bitrate, and printing "0×0 ·  @ 0 kbps" as if it were data is worse
 * than printing nothing.
 */

export interface HlsLevelSummarySource {
  width?: number
  height?: number
  bitrate?: number
  name?: string | null
}

/** Human label for one level: resolution first, since that is what a viewer recognises. */
export function describeHlsLevel(level: HlsLevelSummarySource, index: number): string {
  const parts: string[] = []
  if ((level.height ?? 0) > 0) parts.push(`${level.height}p`)
  else if (level.name) parts.push(level.name)
  else parts.push(`Level ${index + 1}`)
  if ((level.bitrate ?? 0) > 0) parts.push(`${Math.round((level.bitrate ?? 0) / 1000)} kbps`)
  return parts.join(' · ')
}

/**
 * Whether a level carries anything actually worth displaying. False is common and expected: a
 * single-rendition playlist (what these providers serve) yields a level object with no
 * width/height/bitrate, and a stats row reading "0×0 @ 0 kbps" is noise dressed as diagnostics.
 */
export function hasInformativeLevelData(level: HlsLevelSummarySource | null | undefined): boolean {
  if (!level) return false
  return (level.width ?? 0) > 0 || (level.height ?? 0) > 0 || (level.bitrate ?? 0) > 0
}
