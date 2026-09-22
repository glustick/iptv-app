from pathlib import Path

p = Path('src/renderer/src/components/GuideSettingsPage.tsx')
s = p.read_text(encoding='utf-8')

def sub_once(old, new, tag):
    global s
    assert s.count(old) == 1, f'[{tag}] expected 1, found {s.count(old)}: {old[:80]!r}'
    s = s.replace(old, new, 1)

# ---- removeSource: the editor it used to close no longer exists ----
sub_once(
    """  function removeSource(url: string): void {
    removeCustomEpgUrl(url)
    if (matchFor?.sourceUrl === url) setMatchFor(null)
    // A removed source can't keep its editor open — leaving it would show the picker for a guide
    // that is no longer in the pool.
    if (mappingOpenFor === url) setMappingOpenFor(null)
  }
""",
    """  function removeSource(url: string): void {
    removeCustomEpgUrl(url)
  }
""",
    'removeSource'
)

# ---- the per-source card becomes a summary row: what the guide holds, what it matched, and a
#      switch for its listings. Per-channel matching now lives in the right-click panel ----
sub_once(
    """            return (
              <div key={url} className="guide-source-card">
                <div className="guide-source-head">
                  {persistedIndex >= 0 && (
                    <span className="guide-source-priority" title="Guide priority">
                      <button
                        className="icon-button"
                        disabled={persistedIndex === 0}
                        onClick={() => reorderCustomEpgUrls(persistedIndex, persistedIndex - 1)}
                        title="Higher priority"
                        aria-label={`Move ${url} up in priority`}
                      >
                        ⬆
                      </button>
                      <button
                        className="icon-button"
                        disabled={persistedIndex === settings.customEpgUrls.length - 1}
                        onClick={() => reorderCustomEpgUrls(persistedIndex, persistedIndex + 1)}
                        title="Lower priority"
                        aria-label={`Move ${url} down in priority`}
                      >
                        ⬇
                      </button>
                    </span>
                  )}
                  <span className="guide-source-title epg-source-url" title={url}>
                    {url}
                  </span>
                  {statusChip}
                  <span className="guide-source-actions">
                    <button
                      className="secondary-button"
                      onClick={() => toggleMappingEditor(url)}
                      title="Manually map this source's guide channels to your provider's channels"
                    >
                      {mappingOpenFor === url ? 'Close mapping' : 'Map channels'}
                      {mappings.length > 0 ? ` (${mappings.length})` : ''}
                    </button>
                    <button className="secondary-button" onClick={() => removeSource(url)} title="Remove this EPG source">
                      Remove
                    </button>
                  </span>
                </div>
                {issue && <p className="epg-source-issue">⚠ {issue}</p>}
                {renderMatchSummary(url)}
                {mappingOpenFor === url && renderMappingEditor(url)}
              </div>
            )
          })}""",
    """            const hidden = settings.hiddenEpgSourceUrls.includes(url)
            return (
              <div key={url} className={hidden ? 'guide-source-card guide-source-card--hidden' : 'guide-source-card'}>
                <div className="guide-source-head">
                  {persistedIndex >= 0 && (
                    <span className="guide-source-priority" title="Guide priority">
                      <button
                        className="icon-button"
                        disabled={persistedIndex === 0}
                        onClick={() => reorderCustomEpgUrls(persistedIndex, persistedIndex - 1)}
                        title="Higher priority"
                        aria-label={`Move ${url} up in priority`}
                      >
                        ⬆
                      </button>
                      <button
                        className="icon-button"
                        disabled={persistedIndex === settings.customEpgUrls.length - 1}
                        onClick={() => reorderCustomEpgUrls(persistedIndex, persistedIndex + 1)}
                        title="Lower priority"
                        aria-label={`Move ${url} down in priority`}
                      >
                        ⬇
                      </button>
                    </span>
                  )}
                  <span className="guide-source-title epg-source-url" title={url}>
                    {url}
                  </span>
                  {/* What this source actually contributes, in the order the request asked for it:
                      how big the guide is, then how much of the catalogue it matched. */}
                  <span className="guide-source-summary">
                    {guide ? `${guide.channels.size} guide channels` : 'no guide loaded'}
                    {(() => {
                      const stat = epgSourceMatchStats.find((entry) => entry.source === url)
                      if (!stat) return ''
                      return stat.available
                        ? ` · matched ${stat.matched} of ${stat.loadedChannels}`
                        : ` · ${stat.reason ?? 'unavailable'}`
                    })()}
                    {mappings.length > 0 ? ` · ${mappings.length} manual` : ''}
                  </span>
                  {statusChip}
                  <span className="guide-source-actions">
                    <button
                      className="secondary-button"
                      onClick={() => setEpgSourceHidden(url, !hidden)}
                      title={
                        hidden
                          ? "Switch this source's listings back on"
                          : "Stop this source supplying listings, without removing it"
                      }
                    >
                      {hidden ? 'Show guide' : 'Hide guide'}
                    </button>
                    <button className="secondary-button" onClick={() => removeSource(url)} title="Remove this EPG source">
                      Remove
                    </button>
                  </span>
                </div>
                {hidden && (
                  <p className="guide-source-issue guide-source-issue--muted">
                    Hidden — its listings are switched off, but it stays in the priority order and keeps its
                    manual mappings for when you switch it back on.
                  </p>
                )}
                {issue && !hidden && <p className="epg-source-issue">⚠ {issue}</p>}
                {/* The full matching breakdown, collapsed: the summary above is what gets read, this
                    is what gets consulted when a number looks wrong. */}
                {renderMatchSummary(url)}
              </div>
            )
          })}""",
    'card -> summary row'
)

# ---- the section-level hint now points at the right-click flow for individual channels ----
sub_once(
    """            Sources are tried in priority order — the provider's guide first, then your sources top
            to bottom (use ⬆⬇ to reprioritise) — and the first one with programmes for a channel
            supplies it.""",
    """            Sources are tried in priority order — the provider's guide first, then your sources top
            to bottom (use ⬆⬇ to reprioritise) — and the first one with programmes for a channel
            supplies it. To match one channel by hand, right-click it in the guide and choose
            <strong> EPG match…</strong>.""",
    'section hint'
)

p.write_text(s, encoding='utf-8')
print('phase 3 done')
