/**
 * Splitting a large XMLTV document into independently-parseable sections.
 *
 * Why this exists: this app's own provider serves a **16.3 MB gzipped / 107.4 MB XML** guide
 * (measured 2026-09-22). Parsing it the obvious way — hand the whole string to the XML parser — has
 * two consequences that were both observed live: the renderer's memory peaks around a gigabyte,
 * because the parser materialises a complete object tree of the document *before* any of it is
 * converted into the far smaller Maps the app actually keeps; and the parse runs synchronously on
 * the main thread, so the window is frozen for the duration ("the application hangs").
 *
 * The fix is to chop the document at top-level element boundaries and parse the pieces one at a
 * time, yielding to the event loop between them. Each piece is a complete, well-formed document
 * (the same XML declaration, DOCTYPE and `<tv>` wrapper, closed at the end), so the existing parser
 * sees exactly the shape it always did and no parsing semantics change — only *how much of the
 * document exists as objects at once*, and who else gets to run while it happens.
 *
 * Safety of the scan: `<programme` / `<channel` are looked for as literal substrings, which is
 * sound for XMLTV because any such text inside a title or description is entity-escaped (`&lt;…`),
 * and the only other place those words appear is as the element names themselves.
 *
 * Pure and dependency-free — deliberately, per STATE.md's direction note about keeping logic
 * portable to the browser sibling.
 */

/** One parseable piece of a guide, plus the wrapper it needs to stand alone. */
export interface XmltvSectionPlan {
  /** Declaration, DOCTYPE and the opening `<tv …>` tag — reproduced verbatim in every section. */
  header: string
  /** The `</tv>` tag and anything after it. */
  footer: string
  /** Body text between the header and footer, already cut at element boundaries. */
  bodies: string[]
  /** Top-level elements seen, for progress reporting. */
  elementCount: number
}

/** A safety net, not a working limit: the provider this was built for serves ~107MB of XML, so a
 * cap anywhere near that would refuse a perfectly good guide. This is here to stop a pathological
 * or hostile document from being parsed at all, and is set far above anything real. */
export const MAX_GUIDE_XML_CHARS = 256 * 1024 * 1024

/** Default section size. Small enough that a section parses in well under a frame budget on a slow
 * machine (~1–2MB of XML per section), large enough that the per-section parser overhead is
 * irrelevant against the work inside it. */
export const DEFAULT_SECTION_CHARS = 4 * 1024 * 1024

/**
 * Cuts `xml` into sections of at most roughly `maxSectionChars` each, always at a top-level element
 * boundary so no element is ever split.
 *
 * A document with no `<tv>` root (or nothing to cut) yields an empty `bodies`, and callers fall back
 * to parsing the whole string — the lenient path the parser already has for a guide with junk on top.
 */
export function splitXmltvIntoSections(xml: string, maxSectionChars = DEFAULT_SECTION_CHARS): XmltvSectionPlan {
  const empty: XmltvSectionPlan = { header: '', footer: '', bodies: [], elementCount: 0 }

  // Lenient about what precedes the root, exactly as the parser is: a BOM, a junk line, a
  // declaration and a DOCTYPE all land in the header — but the header must end at the *<tv>* tag's
  // own `>`, not at the first `>` in the document (which belongs to the XML declaration). Getting
  // that wrong produces "sections" that are fragments of the declaration.
  const tvStart = xml.search(/<tv[\s>]/i)
  if (tvStart < 0) return empty
  const rootOpenEnd = xml.indexOf('>', tvStart)
  if (rootOpenEnd < 0) return empty
  const header = xml.slice(0, rootOpenEnd + 1)

  // Where does the document's own content end? Everything from `</tv>` onwards is the footer.
  const rootClose = xml.lastIndexOf('</tv>')
  if (rootClose < 0 || rootClose < rootOpenEnd) return empty
  const footer = xml.slice(rootClose)

  // Top-level element starts within the body.
  const bodyStart = rootOpenEnd + 1
  const starts: number[] = []
  for (const tag of ['<programme', '<channel']) {
    let at = xml.indexOf(tag, bodyStart)
    while (at >= 0 && at < rootClose) {
      starts.push(at)
      at = xml.indexOf(tag, at + tag.length)
    }
  }
  if (starts.length === 0) return { ...empty, header, footer }
  starts.sort((a, b) => a - b)

  const bodies: string[] = []
  let sectionStart = bodyStart
  for (let i = 0; i < starts.length; i += 1) {
    const nextStart = starts[i]
    // Cut *before* this element once the section has grown past the budget — never mid-element.
    if (nextStart - sectionStart >= maxSectionChars) {
      bodies.push(xml.slice(sectionStart, nextStart))
      sectionStart = nextStart
    }
  }
  bodies.push(xml.slice(sectionStart, rootClose))

  return { header, footer, bodies: bodies.filter((body) => body.trim().length > 0), elementCount: starts.length }
}
