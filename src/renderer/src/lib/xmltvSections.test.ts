import { describe, it, expect } from 'vitest'
import { splitXmltvIntoSections } from './xmltvSections'

const doc = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="test">\n${body}\n</tv>\n`

const channel = (id: string): string => `  <channel id="${id}"><display-name>${id} HD</display-name></channel>`
const programme = (id: string, n: number): string =>
  `  <programme start="20260923120000 +0000" stop="20260923130000 +0000" channel="${id}"><title>Show ${n}</title><desc>About ${n}</desc></programme>`

const bigDoc = (count: number): string => {
  const parts: string[] = []
  for (let i = 0; i < count; i++) parts.push(channel(`c${i}`), programme(`c${i}`, i))
  return doc(parts.join('\n'))
}

describe('splitXmltvIntoSections', () => {
  it('keeps the declaration, DOCTYPE and <tv> wrapper in every section, closing each one', () => {
    const { header, footer, bodies } = splitXmltvIntoSections(bigDoc(50), 400)
    expect(bodies.length).toBeGreaterThan(1)
    expect(header).toContain('<?xml')
    expect(header).toContain('<!DOCTYPE')
    expect(header.trimEnd().endsWith('<tv generator-info-name="test">')).toBe(true)
    expect(footer.trimStart().startsWith('</tv>')).toBe(true)
  })

  it('never splits an element: every section is a well-formed document on its own', () => {
    const { header, footer, bodies } = splitXmltvIntoSections(bigDoc(60), 300)
    for (const body of bodies) {
      const section = header + body + footer
      // Reassembling must produce a document whose element counts match what the body contains.
      expect(section.match(/<channel /g)?.length ?? 0).toBe(section.match(/<\/channel>/g)?.length ?? 0)
      expect(section.match(/<programme /g)?.length ?? 0).toBe(section.match(/<\/programme>/g)?.length ?? 0)
      expect(section).not.toMatch(/<programme[^>]*$/)
    }
  })

  it('puts the whole document in one section when it fits the budget', () => {
    const { bodies, elementCount } = splitXmltvIntoSections(bigDoc(5), 10_000_000)
    expect(bodies.length).toBe(1)
    // 5 channels + 5 programmes.
    expect(elementCount).toBe(10)
  })

  it('loses nothing: the bodies reassemble to exactly the original body text', () => {
    const xml = bigDoc(30)
    const { header, footer, bodies } = splitXmltvIntoSections(xml, 250)
    const bodyStart = header.length
    const bodyEnd = xml.lastIndexOf('</tv>')
    expect(bodies.join('')).toBe(xml.slice(bodyStart, bodyEnd))
    expect(header + bodies.join('') + footer).toBe(xml)
  })

  it('returns nothing to cut when there is no <tv> root, so the caller can fall back', () => {
    expect(splitXmltvIntoSections('<html><body>not a guide</body></html>').bodies).toEqual([])
    expect(splitXmltvIntoSections('').bodies).toEqual([])
  })

  it('tolerates a BOM and junk before the root, as the parser itself does', () => {
    const xml = '\uFEFFjunk line\n' + doc(channel('c1') + '\n' + programme('c1', 1))
    const { header, bodies, elementCount } = splitXmltvIntoSections(xml, 10_000_000)
    expect(header.startsWith('\uFEFFjunk line')).toBe(true)
    expect(bodies.length).toBe(1)
    expect(elementCount).toBe(2)
  })
})
