/** One #EXTINF entry plus the stream URL that follows it. */
export interface M3uChannel {
  name: string
  tvgId: string | null
  tvgLogo: string | null
  groupTitle: string | null
  url: string
}

export interface ParsedM3u {
  channels: M3uChannel[]
  // From #EXTM3U's own url-tvg/x-tvg-url attribute, if present — lets a playlist that already
  // names its own EPG source work without the user having to find and paste that URL separately.
  epgUrl: string | null
}

const ATTRIBUTE_PATTERN = /([a-zA-Z0-9_-]+)="([^"]*)"/g

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of text.matchAll(ATTRIBUTE_PATTERN)) {
    attrs[match[1].toLowerCase()] = match[2]
  }
  return attrs
}

/**
 * Parses the extended M3U format IPTV providers actually use (#EXTM3U header, #EXTINF entries
 * carrying tvg-id/tvg-logo/group-title attributes, one stream URL per entry) — not a general
 * playlist parser, since this app only ever needs the subset relevant to live channels. VOD/
 * series aren't modeled here at all: a flat M3U has no structured equivalent of Xtream's
 * separate movie/series catalogs, category names are the only real organizing signal a
 * provider gives, and guessing content type from name/group patterns would be provider-
 * specific guesswork rather than something this format actually defines.
 */
export function parseM3u(content: string): ParsedM3u {
  // Some providers' files start with a UTF-8 BOM; \r\n line endings are also common.
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)

  let epgUrl: string | null = null
  const channels: M3uChannel[] = []
  let pending: { attrs: Record<string, string>; name: string } | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('#EXTM3U')) {
      const attrs = parseAttributes(line)
      epgUrl = attrs['x-tvg-url'] || attrs['url-tvg'] || null
      continue
    }

    if (line.startsWith('#EXTINF:')) {
      // The display name starts at the first comma that isn't inside a quoted attribute value —
      // a comma can legitimately appear inside one (e.g. tvg-name="Show, The"), so a plain
      // indexOf/lastIndexOf would either cut an attribute value in half or, if the name itself
      // also contains a comma, misidentify where the name actually starts.
      let splitAt = -1
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') inQuotes = !inQuotes
        else if (ch === ',' && !inQuotes) {
          splitAt = i
          break
        }
      }
      const attrsPart = splitAt === -1 ? line : line.slice(0, splitAt)
      const name = (splitAt === -1 ? '' : line.slice(splitAt + 1)).trim()
      const attrs = parseAttributes(attrsPart)
      pending = { attrs, name: name || attrs['tvg-name'] || 'Unnamed channel' }
      continue
    }

    // Any other '#' line (#EXTGRP, #EXTVLCOPT, a plain comment) carries no URL of its own —
    // skip it without losing the #EXTINF entry still waiting for its stream URL below.
    if (line.startsWith('#')) continue

    // First non-comment line after an #EXTINF is that entry's stream URL.
    if (pending) {
      channels.push({
        name: pending.name,
        tvgId: pending.attrs['tvg-id'] || null,
        tvgLogo: pending.attrs['tvg-logo'] || null,
        groupTitle: pending.attrs['group-title'] || null,
        url: line
      })
      pending = null
    }
    // A URL with no preceding #EXTINF has nothing to name it — not a shape this app can
    // represent as a channel, so it's silently skipped rather than guessed at.
  }

  return { channels, epgUrl }
}
