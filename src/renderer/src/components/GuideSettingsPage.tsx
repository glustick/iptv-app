import { useState } from 'react'
import { useAppStore, PROVIDER_GUIDE_LABEL } from '../store/useAppStore'
import { unionEpgSourceUrls } from '../lib/epg'

// The confidence floors offered for the bulk suggestion apply, shared by the per-source and the
// section-wide runs so the two never drift apart.
const BULK_THRESHOLDS = [0.6, 0.7, 0.8, 0.9, 1]

/**
 * "Guide & EPG" — the EPG configuration, on its own surface rather than buried in Settings
 * (0.7.92).
 *
 * Settings had grown into one long scroll where the guide pool, the two-pane mapping editor and
 * the per-source match report sat between the parental PIN and the VPN profiles. That block was
 * by far the largest and most stateful part of the modal, and it is a different job from the rest
 * of the page: "why does this channel have no listings?" rather than "what clock format do I
 * want?". It now has its own modal, with room to lay the sources out as cards (status, match
 * counts and actions on the source they belong to) instead of one flat list above a separate
 * report. The mechanics are unchanged — same store actions, same matching tiers, same manual
 * mappings — it is the presentation that moved.
 *
 * Discovery is deliberately preserved: the top bar's own button opens it directly, Settings keeps
 * a compact "Guide & EPG" row that links here (with a one-line status), and the grid's "no
 * listings for this channel" hint opens it too. It reuses Settings' modal pattern — same overlay,
 * same Escape chain entry (see lib/overlays.ts), same click-outside-to-close.
 */
export function GuideSettingsPage(): JSX.Element | null {
  const guideOpen = useAppStore((s) => s.guideOpen)
  const closeGuide = useAppStore((s) => s.closeGuide)
  const settings = useAppStore((s) => s.settings)
  const epgSourcesStatus = useAppStore((s) => s.epgSourcesStatus)
  const epgSourceIssues = useAppStore((s) => s.epgSourceIssues)
  const epgSourceMatchStats = useAppStore((s) => s.epgSourceMatchStats)
  const epgSources = useAppStore((s) => s.epgSources)
  const epgSourceLabels = useAppStore((s) => s.epgSourceLabels)
  const epgLoadProgress = useAppStore((s) => s.epgLoadProgress)
  const providerGuideAvailable = useAppStore((s) => s.providerGuideAvailable)
  const addCustomEpgUrl = useAppStore((s) => s.addCustomEpgUrl)
  const removeCustomEpgUrl = useAppStore((s) => s.removeCustomEpgUrl)
  const reorderCustomEpgUrls = useAppStore((s) => s.reorderCustomEpgUrls)
  const applySuggestedMappingsAcrossSources = useAppStore((s) => s.applySuggestedMappingsAcrossSources)
  // "Show/hide its guide" — a hidden source is loaded but supplies no listings (see
  // applyEpgPool); the summary row below carries the toggle.
  const setEpgSourceHidden = useAppStore((s) => s.setEpgSourceHidden)

  const [epgUrlDraft, setEpgUrlDraft] = useState('')
  // Bulk suggestion apply: the confidence floor to use, and what the last run reported.
  const [bulkThreshold, setBulkThreshold] = useState(0.8)
  // The section-level "all sources at once" run reports separately from the per-source run that
  // used to live inside the mapping editor — different scopes, so sharing one message would be
  // confusing. The per-channel counterpart is the match panel (see ChannelMatchModal).
  const [bulkAllResult, setBulkAllResult] = useState<string | null>(null)
  // The bulk run resolves the whole catalogue, chunked so the window keeps painting — this drives
  // the "working" state on the buttons so the run never looks like nothing happened.
  const [bulkBusy, setBulkBusy] = useState(false)

  if (!guideOpen) return null

  // The EPG sources list is the UNION of persisted and currently-live sources (see
  // unionEpgSourceUrls) — anything the app is still fetching stays listed and removable even
  // if a state round-trip bug ever leaves it out of settings.
  const listedSources = unionEpgSourceUrls(settings.customEpgUrls, epgSourceLabels, PROVIDER_GUIDE_LABEL)
  const manualMappingCount = settings.epgChannelMappings.length

  // Availability of the provider's own guide, as a status line for its (read-only) card. null means
  // the app hasn't got an answer yet — either not connected, or the sources are still loading.
  const providerGuideStatus =
    providerGuideAvailable === true
      ? { cls: 'guide-chip guide-chip--ok', text: 'Available' }
      : providerGuideAvailable === false
        ? { cls: 'guide-chip guide-chip--warn', text: 'Blocked or disabled by this provider' }
        : { cls: 'guide-chip guide-chip--muted', text: epgSourcesStatus === 'loading' ? 'Checking…' : 'Not checked' }

  function removeSource(url: string): void {
    removeCustomEpgUrl(url)
  }

  // Resolves the WHOLE catalog against the open source's guide to find channels that still have
  // no listings from it — the residue left after the automatic tiers and manual mappings (a
  // match with zero programmes counts as unresolved, same rule as the store's match report).
  // Runs from event handlers only, never per render: the walk is fine as a one-off on a click,
  // but it would make typing in the search box stutter.
  async function handleBulkApplyAll(): Promise<void> {
    const percent = Math.round(bulkThreshold * 100)
    setBulkBusy(true)
    const result = await applySuggestedMappingsAcrossSources(bulkThreshold)
    setBulkBusy(false)
    setBulkAllResult(
      result.applied > 0
        ? `Applied ${result.applied} mapping${result.applied === 1 ? '' : 's'} across ${
            result.perSource.length
          } source${result.perSource.length === 1 ? '' : 's'} — see "by manual mapping" below.`
        : `No unmatched channel scored ${percent}% or better in any source — try a lower threshold.`
    )
  }

  // Applies the good suggestions for the whole source in one go, then reports exactly what it did
  // — including how many channels still need a human eye. If the "only unmatched" filter is on,
  // its set is recomputed so the list immediately reflects what's left.
  function renderMatchSummary(label: string): JSX.Element | null {
    const stat = epgSourceMatchStats.find((s) => s.source === label)
    if (!stat) {
      // No report entry yet: still loading, or the guide pool hasn't been applied. The card's own
      // status chip already says which, so there is nothing honest to add here.
      return null
    }
    return (
      <div className="epg-match-row">
        <p className="epg-match-line">
          {stat.available ? (
            stat.loadedChannels === 0 ? (
              <span>
                Loaded. Open a channel category to see its matching.
              </span>
            ) : (
              <span>
                Matched {stat.matched} of {stat.loadedChannels} loaded channels ({stat.byId} by EPG id, {stat.byName} by
                name
                {stat.byFuzzy > 0 ? `, ${stat.byFuzzy} by relaxed match` : ''}
                {stat.byManual > 0 ? `, ${stat.byManual} by manual mapping` : ''})
              </span>
            )
          ) : (
            <span>{stat.reason ?? 'unavailable'}</span>
          )}
        </p>
        {stat.available && stat.matched < stat.loadedChannels && stat.loadedChannels > 0 && (
          <details className="guide-unmatched">
            <summary>
              {stat.loadedChannels - stat.matched} unmatched channel
              {stat.loadedChannels - stat.matched === 1 ? '' : 's'}
            </summary>
            <p className="epg-match-unmatched" title="First 30 unmatched channel names in the loaded category">
              No match for: {stat.unmatchedNames.join(', ')}
              {stat.loadedChannels - stat.matched > stat.unmatchedNames.length
                ? ` … and ${stat.loadedChannels - stat.matched - stat.unmatchedNames.length} more`
                : ''}
            </p>
          </details>
        )}
      </div>
    )
  }

  // The per-source mapping panel: existing guide→channel links, plus a two-pane searchable
  // picker for new ones. Guide channels come from the already-parsed guide (epgSources), so an
  // editor for a source that failed to load shows guidance instead of an empty picker.
  return (
    <div className="modal-overlay" onClick={closeGuide}>
      <div className="modal-card guide-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Guide &amp; EPG</h2>
            <p className="guide-subtitle">
              Listing sources, automatic matching, and manual channel maps
            </p>
          </div>
          <button className="modal-close" onClick={closeGuide} title="Close guide settings">
            ✕
          </button>
        </div>

        {/* At-a-glance health of the guide pool, so the common question ("is my guide even
            working?") has an answer before scrolling into the source list. */}
        <div className="guide-stats">
          <div className="guide-stat">
            <span className="guide-stat-label">Guide status</span>
            <span className="guide-stat-value">
              {epgSourcesStatus === 'ready' ? 'Ready' : epgSourcesStatus === 'loading' ? 'Loading…' : 'Not loaded'}
            </span>
          </div>
          <div className="guide-stat">
            <span className="guide-stat-label">Provider guide</span>
            <span className="guide-stat-value">
              {providerGuideAvailable === true ? 'Available' : providerGuideAvailable === false ? 'Unavailable' : '—'}
            </span>
          </div>
          <div className="guide-stat">
            <span className="guide-stat-label">Your sources</span>
            <span className="guide-stat-value">{settings.customEpgUrls.length}</span>
          </div>
          <div className="guide-stat">
            <span className="guide-stat-label">Manual maps</span>
            <span className="guide-stat-value">{manualMappingCount}</span>
          </div>
        </div>

        <section className="guide-section">
          <h3>Sources</h3>
          <p className="settings-hint">
            Sources are tried in priority order — the provider&apos;s guide first, then your sources top
            to bottom (use ⬆⬇ to reprioritise) — and the first one with programmes for a channel
            supplies it.
          </p>

          {/* The provider's own guide: always first, always tried, but neither removed nor mapped
              by hand (its channel ids are what epg_channel_id already refers to — see
              EpgChannelMapping). It appears here as a card so its status and match counts sit
              beside the sources they compete with, instead of only in a separate report. */}
          <div className="guide-source-card guide-source-card--provider">
            <div className="guide-source-head">
              <span className="guide-source-title" title="The provider's own xmltv.php guide">
                {PROVIDER_GUIDE_LABEL}
              </span>
              <span className={providerGuideStatus.cls}>{providerGuideStatus.text}</span>
              <span className="guide-chip guide-chip--muted">Built in</span>
            </div>
            {renderMatchSummary(PROVIDER_GUIDE_LABEL)}
          </div>

          {listedSources.map((url) => {
            const mappings = settings.epgChannelMappings.filter((m) => m.sourceUrl === url)
            // Priority arrows only make sense for sources that are actually persisted — a row
            // that only exists as live pool state has no stored position to move.
            const persistedIndex = settings.customEpgUrls.indexOf(url)
            const sourceIndex = epgSourceLabels.indexOf(url)
            const guide = sourceIndex >= 0 ? epgSources[sourceIndex] : null
            const issue = epgSourceIssues[url]
            // One status chip per source: the failure reason when there is one, otherwise whether
            // its guide is actually parsed and how many channels it carries.
            const statusChip = issue ? (
              <span className="guide-chip guide-chip--warn" title={issue}>
                ⚠ Failed
              </span>
            ) : guide ? (
              <span className="guide-chip guide-chip--ok">{guide.channels.size} guide channels</span>
            ) : epgSourcesStatus === 'loading' ? (
              <span className="guide-chip guide-chip--muted">Loading…</span>
            ) : (
              <span className="guide-chip guide-chip--muted">Not loaded</span>
            )
            const hidden = settings.hiddenEpgSourceUrls.includes(url)
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
                      how big its guide is, then how much of the catalogue it matched. */}
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
                          : 'Stop this source supplying listings, without removing it'
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
                    Hidden — its listings are switched off, but it keeps its place in the priority order and its
                    manual mappings for when you switch it back on.
                  </p>
                )}
                {issue && !hidden && <p className="epg-source-issue">⚠ {issue}</p>}
                {/* The full matching breakdown, collapsed: the summary above is what gets read, this is
                    what gets consulted when a number looks wrong. */}
                {renderMatchSummary(url)}
              </div>
            )
          })}

          <div className="pin-set-row">
            <input
              type="url"
              placeholder="https://example.com/epg.xml"
              value={epgUrlDraft}
              onChange={(e) => setEpgUrlDraft(e.target.value)}
            />
            <button
              disabled={!epgUrlDraft.trim()}
              onClick={() => {
                addCustomEpgUrl(epgUrlDraft)
                setEpgUrlDraft('')
              }}
            >
              Add source
            </button>
          </div>

          {/* Section-level bulk apply: one action over every source, for when the residue is
              spread across several of them and working source-by-source would be tedious. */}
          {settings.customEpgUrls.length > 0 && (
            <>
              <div className="epg-bulk-apply">
                <label>
                  Auto-map every source at
                  <select value={bulkThreshold} onChange={(e) => setBulkThreshold(Number(e.target.value))}>
                    {BULK_THRESHOLDS.map((value) => (
                      <option key={value} value={value}>
                        {Math.round(value * 100)}%
                      </option>
                    ))}
                  </select>
                  or better
                </label>
                <button className="secondary-button" disabled={bulkBusy} onClick={() => void handleBulkApplyAll()}>
                  {bulkBusy ? 'Applying…' : 'Apply across all sources'}
                </button>
              </div>
              {bulkAllResult && <p className="epg-bulk-result">{bulkAllResult}</p>}
            </>
          )}

          {epgSourcesStatus === 'loading' && (
            <p className="settings-hint">
              Loading guide sources…
              {/* Section-by-section progress, shown because a large guide takes real time and used
                  to freeze the window while it did: a moving counter is the honest sign of life. */}
              {epgLoadProgress ? ` section ${epgLoadProgress.done} of ${epgLoadProgress.total}` : ''}
            </p>
          )}
        </section>

        {/* The long "how this works" prose, which used to sit permanently open above the source
            list in Settings, is now a disclosure — the explanation is one click away instead of
            pushing the actual controls off the first screen. */}
        <details className="guide-help">
          <summary>How guide matching works</summary>
          <p className="settings-hint">
            Providers only send listings for roughly the rest of today per channel. Adding a full
            guide (any XMLTV URL, plain or .xml.gz — the community &quot;iptv-org/epg&quot; project on GitHub is a
            common source of them; its old iptv-org.github.io/epg address no longer serves guides) fills in later days and channels your provider doesn&apos;t
            cover. Plain-text or PDF schedules can&apos;t be parsed — only the XMLTV form, however
            the file is named. Channels are matched by EPG id first, then by name, then by a
            relaxed match that ignores HD/SD tags, leading channel numbers, country prefixes
            and accents — and a channel you map manually overrides all of those when the
            automatic joins still get one wrong or miss it. Your provider&apos;s own listings
            always win where they exist, and the channel preview shows which source supplied the
            listings you&apos;re looking at.
          </p>
        </details>
      </div>
    </div>
  )
}
