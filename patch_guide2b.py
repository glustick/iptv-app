from pathlib import Path

p = Path('src/renderer/src/store/useAppStore.ts')
s = p.read_text(encoding='utf-8')

def sub_once(old, new, tag):
    global s
    assert s.count(old) == 1, f'[{tag}] expected 1, found {s.count(old)}: {old[:70]!r}'
    s = s.replace(old, new, 1)

sub_once("  parseXmltv,\n", "  parseXmltv,\n  parseXmltvProgressive,\n", 'import')

sub_once(
    """  epgSourcesStatus: 'idle' | 'loading' | 'ready'""",
    """  epgSourcesStatus: 'idle' | 'loading' | 'ready'
  // Section progress while a large guide is parsed (see parseXmltvProgressive): null when nothing is
  // being parsed, so the UI can show "section 7 of 12" instead of an inert "Loading…" — which is
  // also how a user can see that the window is still alive during a load that used to freeze it.
  epgLoadProgress: { done: number; total: number } | null""",
    'state field'
)

# initial state + the two per-connection resets, each anchored on its own indentation
for indent, tag in (('  ', 'initial'), ('        ', 'connect'), ('      ', 'disconnect')):
    sub_once(
        f"{indent}epgSourcesStatus: 'idle',\n",
        f"{indent}epgSourcesStatus: 'idle',\n{indent}epgLoadProgress: null,\n",
        f'reset {tag}'
    )

sub_once(
    """    set({ epgSourcesStatus: 'loading' })""",
    """    set({ epgSourcesStatus: 'loading', epgLoadProgress: null })""",
    'loading reset'
)

sub_once(
    """        sources.push(parseXmltv(await client.getFullEpgXml()))
        labels.push(PROVIDER_GUIDE_LABEL)
        providerGuideAvailable = true""",
    """        // The provider's own guide is the one that gets big — 16.3MB gzipped / 107.4MB of XML on
        // this app's own provider, measured 2026-09-22 — so it is parsed in sections, reporting
        // progress, with the event loop getting a turn between them (see parseXmltvProgressive).
        // That is what stops the window freezing while it loads. The size check is a safety net
        // against a pathological document, and sits far above any real guide (MAX_GUIDE_XML_CHARS).
        const providerXml = await client.getFullEpgXml()
        if (providerXml.length > MAX_GUIDE_XML_CHARS) {
          throw new Error(
            `guide is ${Math.round(providerXml.length / 1048576)}MB — beyond the ${Math.round(MAX_GUIDE_XML_CHARS / 1048576)}MB safety limit`
          )
        }
        sources.push(
          await parseXmltvProgressive(providerXml, {
            onProgress: (done, total) => {
              // A newer load owns the status once its token has been issued (see the seq guard).
              if (seq === epgSourcesLoadSeq) set({ epgLoadProgress: { done, total } })
            }
          })
        )
        labels.push(PROVIDER_GUIDE_LABEL)
        providerGuideAvailable = true""",
    'provider progressive'
)

sub_once(
    """        const parsed = parseXmltv(await decodeMaybeGzipBytes(await res.arrayBuffer()))""",
    """        const text = await decodeMaybeGzipBytes(await res.arrayBuffer())
        if (text.length > MAX_GUIDE_XML_CHARS) {
          throw new Error(
            `guide is ${Math.round(text.length / 1048576)}MB — beyond the ${Math.round(MAX_GUIDE_XML_CHARS / 1048576)}MB safety limit`
          )
        }
        const parsed = await parseXmltvProgressive(text, {
          onProgress: (done, total) => {
            if (seq === epgSourcesLoadSeq) set({ epgLoadProgress: { done, total } })
          }
        })""",
    'custom progressive'
)

sub_once(
    """    set({ epgSources: sources, epgSourceLabels: labels, providerGuideAvailable, epgSourcesStatus: 'ready', epgSourceIssues: issues })""",
    """    set({
      epgSources: sources,
      epgSourceLabels: labels,
      providerGuideAvailable,
      epgSourcesStatus: 'ready',
      epgSourceIssues: issues,
      epgLoadProgress: null
    })""",
    'clear on ready'
)

# import the cap
p.write_text(s, encoding='utf-8')
s = p.read_text(encoding='utf-8')
old = "import {\n  analyzeMediaPlaylist,"
assert s.count(old) == 1, s.count(old)
s = s.replace(old, "import { MAX_GUIDE_XML_CHARS } from '../lib/xmltvSections'\nimport {\n  analyzeMediaPlaylist,", 1)
p.write_text(s, encoding='utf-8')
print('store wired for progressive parse')
