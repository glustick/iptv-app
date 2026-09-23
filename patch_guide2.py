from pathlib import Path

def patch(path, pairs):
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    for old, new, tag in pairs:
        assert s.count(old) == 1, f'{path} [{tag}]: expected 1, found {s.count(old)}: {old[:70]!r}'
        s = s.replace(old, new, 1)
    p.write_text(s, encoding='utf-8')
    print('patched', path, f'({len(pairs)})')

patch('src/renderer/src/store/useAppStore.ts', [(
    """  parseXmltv,""",
    """  parseXmltv,
  parseXmltvProgressive,""",
    'import'
), (
    """  epgSourcesStatus: 'idle' | 'loading' | 'ready'""",
    """  epgSourcesStatus: 'idle' | 'loading' | 'ready'
  // Section progress while a large guide is being parsed (see parseXmltvProgressive): null when
  // nothing is being parsed, so the UI can say "7 of 12 sections" instead of an inert "Loading…" —
  // which is also how a user can see for themselves that the window is still alive during a load
  // that used to freeze it.
  epgLoadProgress: { done: number; total: number } | null""",
    'progress state'
), (
    """  epgSourcesStatus: 'idle',""",
    """  epgSourcesStatus: 'idle',
  epgLoadProgress: null,""",
    'progress default'
), (
    """    set({ epgSourcesStatus: 'loading' })""",
    """    set({ epgSourcesStatus: 'loading', epgLoadProgress: null })""",
    'reset progress on load'
), (
    """        sources.push(parseXmltv(await client.getFullEpgXml()))
        labels.push(PROVIDER_GUIDE_LABEL)
        providerGuideAvailable = true""",
    """        // The provider's own guide is the one that gets big — 16.3MB gzipped / 107.4MB of XML on
        // this app's own provider, measured — so it is parsed in sections, reporting progress, with
        // the event loop getting a turn between them (see parseXmltvProgressive). A safety net
        // refuses a document so large that parsing it is not a reasonable thing to do at all; it
        // sits far above any real guide (see MAX_GUIDE_XML_CHARS).
        const providerXml = await client.getFullEpgXml()
        if (providerXml.length > MAX_GUIDE_XML_CHARS) {
          throw new Error(`guide is ${Math.round(providerXml.length / 1048576)}MB — beyond the ${Math.round(MAX_GUIDE_XML_CHARS / 1048576)}MB safety limit`)
        }
        sources.push(
          await parseXmltvProgressive(providerXml, {
            onProgress: (done, total) => {
              if (seq === epgSourcesLoadSeq) set({ epgLoadProgress: { done, total } })
            }
          })
        )
        labels.push(PROVIDER_GUIDE_LABEL)
        providerGuideAvailable = true""",
    'provider guide progressive'
), (
    """        const parsed = parseXmltv(await decodeMaybeGzipBytes(await res.arrayBuffer()))""",
    """        const text = await decodeMaybeGzipBytes(await res.arrayBuffer())
        if (text.length > MAX_GUIDE_XML_CHARS) {
          throw new Error(`guide is ${Math.round(text.length / 1048576)}MB — beyond the ${Math.round(MAX_GUIDE_XML_CHARS / 1048576)}MB safety limit`)
        }
        const parsed = await parseXmltvProgressive(text, {
          onProgress: (done, total) => {
            if (seq === epgSourcesLoadSeq) set({ epgLoadProgress: { done, total } })
          }
        })""",
    'custom guide progressive'
), (
    """    set({ epgSources: sources, epgSourceLabels: labels, providerGuideAvailable, epgSourcesStatus: 'ready', epgSourceIssues: issues })""",
    """    set({
      epgSources: sources,
      epgSourceLabels: labels,
      providerGuideAvailable,
      epgSourcesStatus: 'ready',
      epgSourceIssues: issues,
      epgLoadProgress: null
    })""",
    'clear progress on completion'
)])

# the size-cap import
p = Path('src/renderer/src/store/useAppStore.ts')
s = p.read_text(encoding='utf-8')
old = "import {\n  analyzeMediaPlaylist,"
assert s.count(old) == 1
s = s.replace(old, "import { MAX_GUIDE_XML_CHARS } from '../lib/xmltvSections'\nimport {\n  analyzeMediaPlaylist,", 1)
p.write_text(s, encoding='utf-8')
print('import added')
