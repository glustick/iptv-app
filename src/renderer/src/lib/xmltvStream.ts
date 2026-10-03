import type { EpgChannel, EpgData, EpgProgramme } from './epg'

// A streaming XMLTV scanner: the same EpgData parseXmltv used to produce, without ever building
// a DOM of the document.
//
// Ported from the web sibling (allison-web-iptv v0.73.0, src/server/lib/xmltvStream.ts), where
// the DOM parse's footprint was measured at ~1.3GB of heap for a single 195MB guide — the guide
// set had grown past what the process could parse, and every load OOM'd. This app parses in the
// renderer with sectioned DOM parses (parseXmltvProgressive), which bounds the spike per
// section but still pays a full DOM per 4MB slice and holds the whole document text throughout;
// the scanner holds a small constant buffer plus the retained guide, and one instance spans
// every slice (no section-straddle re-sorting, no entity-expansion caps, no preamble surgery).
//
// Desktop semantics preserved (they differ from the web copy deliberately):
// - start/stop are Date objects, and unparseable dates are KEPT as Invalid Dates — consumers
//   (xmltvProgrammesToShort) filter them, exactly as before.
// - No prune window: every programme in the document is retained.
// - Text leaves keep fast-xml-parser's contract: entities decoded (&amp; and friends plus
//   numeric references), CDATA unwrapped with its content left undecoded. There is no markup
//   stripping or length capping — this app's parser never had any.
// - A document with no <tv> root is an EMPTY GUIDE, not an error — the caller flags "didn't
//   look like an XMLTV guide" from the zero channel count, same as before.
//
// Documented deviations (both improvements, pinned by tests): where a channel/programme carries
// multiple <title>/<desc>/<display-name> children (multi-language feeds), the FIRST is kept —
// the DOM path's array-shaped value fell through textOf to "[object Object]"; likewise the
// first <icon> is used where an array previously yielded no icon at all.

const MAX_ELEMENT_BYTES = 4 * 1024 * 1024

/** XMLTV timestamps look like `20240101120000 +0000` — the same parser epg.ts has always used. */
function parseXmltvDate(value: string): Date {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/)
  if (!match) return new Date(value)
  const [, year, month, day, hour, minute, second, offset] = match
  const normalizedOffset = offset ? `${offset.slice(0, 3)}:${offset.slice(3)}` : 'Z'
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${normalizedOffset}`)
}

/** Decodes the XML predefined entities — exactly the scope fast-xml-parser's default entity
 *  processing covers, which is what the DOM parse this scanner replaces did: the five named
 *  forms plus their NUMERIC forms (&#39; → ', &#x27; → ', …), while other numeric character
 *  references and unknown entity names are left as-is. (&amp;/&#38; last, so an ampersand
 *  produced by decoding cannot re-decode the text after it.) */
function decodeXmlEntities(raw: string): string {
  const named: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'" }
  let out = raw.replace(/&(lt|gt|quot|apos);/g, (_, name) => named[name])
  const numericSpecials: Record<string, string> = {
    '34': '"', '38': '&', '39': "'", '60': '<', '62': '>',
    x22: '"', x26: '&', x27: "'", x3c: '<', x3e: '>', x3C: '<', x3E: '>'
  }
  out = out.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_, code: string) => numericSpecials[code] ?? `&#${code};`)
  return out.replace(/&amp;/g, '&')
}

function attributeValue(openTag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(openTag)
  if (!match) return undefined
  return decodeXmlEntities(match[2] ?? match[3] ?? '')
}

/** The first `<leaf…>…</leaf>` inner text inside an element body, or undefined. Entities
 *  decoded, CDATA wrappers unwrapped (their content left undecoded — the DOM contract). */
function leafText(body: string, leaf: string): string | undefined {
  const open = new RegExp(`<${leaf}(\\s[^>]*)?>`).exec(body)
  if (!open) return undefined
  const start = open.index + open[0].length
  const close = body.indexOf(`</${leaf}>`, start)
  if (close === -1) return undefined
  const inner = body.slice(start, close)
  if (!inner.includes('<![CDATA[')) return decodeXmlEntities(inner)
  // Mixed text/CDATA: decode only the parts outside the CDATA sections.
  return inner
    .split(/<!\[CDATA\[|\]\]>/)
    .map((segment, i) => (i % 2 === 1 ? segment : decodeXmlEntities(segment)))
    .join('')
}

function firstIconSrc(body: string): string | undefined {
  const open = /<icon\b[^>]*>/.exec(body)
  if (!open) return undefined
  const src = attributeValue(open[0], 'src')
  return src === undefined ? undefined : src
}

export interface XmltvStreamParser {
  /** Feeds the next text chunk — chunks can split anywhere, including mid-tag and mid-CDATA. */
  write(chunk: string): void
  /** Finishes the document and returns the guide. Throws when the document ends mid-element
   *  (truncated source); a document with no <tv> root returns an empty guide. */
  end(): EpgData
}

export function createXmltvStreamParser(): XmltvStreamParser {
  let buffer = ''
  // Whether anything guide-shaped was ever seen (a <tv> root, a <channel>, a <programme>), and
  // whether the input contained any markup at all. The combination preserves the DOM parse's
  // two distinct failure contracts: markup-bearing content with no guide structure (the
  // corrupt-cache junk the once-a-day cache refetches on, an HTML error page) is an ERROR —
  // the callers' corrupt-copy/refetch paths key off the throw — while TAG-FREE text (a plain
  // .txt schedule in a guide slot) still parses to an empty guide, which the custom-source
  // path reports with its "Plain-text or PDF schedules can't be parsed" advice. A real-but-
  // empty `<tv></tv>` is an empty guide (structure was seen).
  let sawStructure = false
  let sawMarkup = false
  // null = seeking the next <channel>/<programme>; otherwise the element being accumulated.
  let inside: 'channel' | 'programme' | null = null
  let openTag = ''
  let body = ''
  let overflowed = false

  const channels = new Map<string, EpgChannel>()
  const programmesByChannel = new Map<string, EpgProgramme[]>()

  function parseOpenTag(tag: string): void {
    const kind = /^<\s*(channel|programme)\b/.exec(tag)?.[1] as 'channel' | 'programme'
    if (kind === 'channel') {
      const id = attributeValue(tag, 'id') ?? ''
      const displayNameRaw = leafText(body, 'display-name')
      const displayName = displayNameRaw ?? id
      const icon = firstIconSrc(body)
      channels.set(id, icon !== undefined ? { id, displayName, icon } : { id, displayName })
      return
    }
    const channelId = attributeValue(tag, 'channel') ?? ''
    const programme: EpgProgramme = {
      channelId,
      start: parseXmltvDate(attributeValue(tag, 'start') ?? ''),
      stop: parseXmltvDate(attributeValue(tag, 'stop') ?? ''),
      title: leafText(body, 'title') ?? 'Untitled',
      description: leafText(body, 'desc')
    }
    const list = programmesByChannel.get(channelId)
    if (list) {
      list.push(programme)
    } else {
      programmesByChannel.set(channelId, [programme])
    }
  }

  function nextTokenIndex(from: number): { index: number; kind: 'channel' | 'programme' | 'tv' | 'comment' } | -1 {
    const re = /<(channel|programme|tv)[\s/>]|<!--/g
    re.lastIndex = from
    const match = re.exec(buffer)
    if (!match) return -1
    return {
      index: match.index,
      kind: match[0] === '<!--' ? 'comment' : (match[1] as 'channel' | 'programme' | 'tv')
    }
  }

  /** The index of the `>` closing the open tag at `start`, honoring quoted attribute values. */
  function openTagEnd(start: number): number {
    let quote: string | null = null
    for (let i = start; i < buffer.length; i++) {
      const ch = buffer[i]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        return i
      }
    }
    return -1
  }

  function process(): void {
    let p = 0
    for (;;) {
      if (inside) {
        const closeTag = `</${inside}>`
        const close = buffer.indexOf(closeTag, p)
        if (close === -1) {
          // Consume the body — but hold back any trailing partial close tag ('</chan' split
          // across writes would otherwise be eaten as body text and the real close, arriving
          // later, would never match).
          const rest = buffer.slice(p)
          let keep = rest
          let tail = ''
          const max = Math.min(closeTag.length - 1, rest.length)
          for (let k = max; k > 0; k--) {
            if (rest.endsWith(closeTag.slice(0, k))) {
              keep = rest.slice(0, rest.length - k)
              tail = rest.slice(rest.length - k)
              break
            }
          }
          body += keep
          if (body.length > MAX_ELEMENT_BYTES) {
            // Pathological element (never legitimate XMLTV): drop its content but keep
            // scanning for the close tag so the parser can resynchronize.
            overflowed = true
            body = ''
          }
          buffer = tail
          p = 0
          return
        }
        body += buffer.slice(p, close)
        p = close + closeTag.length
        if (!overflowed) parseOpenTag(openTag)
        inside = null
        openTag = ''
        body = ''
        overflowed = false
        continue
      }
      const token = nextTokenIndex(p)
      if (token === -1) {
        buffer = buffer.slice(p)
        return
      }
      if (token.kind === 'comment') {
        const end = buffer.indexOf('-->', token.index)
        if (end === -1) {
          buffer = buffer.slice(token.index)
          return
        }
        p = end + 3
        continue
      }
      if (token.kind === 'tv') {
        // The root is structure, never descended into — its children are found by the scan.
        sawStructure = true
        const gt = openTagEnd(token.index)
        if (gt === -1) {
          buffer = buffer.slice(token.index)
          return
        }
        p = gt + 1
        continue
      }
      const gt = openTagEnd(token.index)
      if (gt === -1) {
        buffer = buffer.slice(token.index)
        return
      }
      const tag = buffer.slice(token.index, gt + 1)
      p = gt + 1
      sawStructure = true
      if (/\/\s*>$/.test(tag)) {
        // Self-closing: a complete element with no children — `<channel id="x"/>` is a real,
        // recordable channel (display name falls back to the id).
        openTag = tag
        body = ''
        overflowed = false
        parseOpenTag(tag)
        continue
      }
      inside = token.kind
      openTag = tag
      body = ''
      overflowed = false
    }
  }

  return {
    write(chunk: string): void {
      if (!sawMarkup && chunk.includes('<')) sawMarkup = true
      buffer += chunk
      process()
    },
    end(): EpgData {
      if (inside) {
        throw new Error('Guide XML ended mid-element — the source is truncated or malformed')
      }
      if (!sawStructure && sawMarkup) {
        // Markup-bearing content with no guide structure — see the state flags' own comment.
        throw new Error('Not an XMLTV guide: no <tv> root element found in the response')
      }
      for (const list of programmesByChannel.values()) {
        list.sort((a, b) => a.start.getTime() - b.start.getTime())
      }
      return { channels, programmesByChannel }
    }
  }
}
