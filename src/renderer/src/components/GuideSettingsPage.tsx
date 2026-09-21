import { useState } from 'react'
import { useAppStore, PROVIDER_GUIDE_LABEL } from '../store/useAppStore'
import { buildGuideIndex, suggestGuideChannels, resolveStreamToGuide, unionEpgSourceUrls, type GuideIndex } from '../lib/epg'

// The mapping editor's search lists render at most this many rows — a full provider catalog
// (or a country-wide iptv-org guide) is thousands of entries, and an unbounded listbox is
// unusable DOM. The hint below each list says when the search needs narrowing.
const MAPPING_LIST_CAP = 60
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
  const providerGuideAvailable = useAppStore((s) => s.providerGuideAvailable)
  const numericChannelCatalog = useAppStore((s) => s.numericChannelCatalog)
  const connectionStatus = useAppStore((s) => s.status)
  const addCustomEpgUrl = useAppStore((s) => s.addCustomEpgUrl)
  const removeCustomEpgUrl = useAppStore((s) => s.removeCustomEpgUrl)
  const reorderCustomEpgUrls = useAppStore((s) => s.reorderCustomEpgUrls)
  const addEpgChannelMapping = useAppStore((s) => s.addEpgChannelMapping)
  const removeEpgChannelMapping = useAppStore((s) => s.removeEpgChannelMapping)
  const ensureChannelCatalog = useAppStore((s) => s.ensureChannelCatalog)
  const applySuggestedMappings = useAppStore((s) => s.applySuggestedMappings)
  const applySuggestedMappingsAcrossSources = useAppStore((s) => s.applySuggestedMappingsAcrossSources)

  const [epgUrlDraft, setEpgUrlDraft] = useState('')
  // Manual channel-mapping editor state — one source's editor open at a time (keyed by the
  // source's URL); searches and picks reset whenever a different editor opens so stale
  // selections from source A can't be submitted into source B.
  const [mappingOpenFor, setMappingOpenFor] = useState<string | null>(null)
  const [guideSearch, setGuideSearch] = useState('')
  const [streamSearch, setStreamSearch] = useState('')
  const [selectedGuideChannelId, setSelectedGuideChannelId] = useState<string | null>(null)
  const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null)
  // Prebuilt lookup tables for the open editor's guide, and the "no listings from this source"
  // filter's result set. Both are computed from event handlers (never during render) because
  // they walk the entire 24k-30k channel catalog once.
  const [guideIndex, setGuideIndex] = useState<GuideIndex | null>(null)
  const [onlyUnmatched, setOnlyUnmatched] = useState(false)
  const [unmatchedIds, setUnmatchedIds] = useState<Set<number> | null>(null)
  // Bulk suggestion apply: the confidence floor to use, and what the last run reported.
  const [bulkThreshold, setBulkThreshold] = useState(0.8)
  const [bulkResult, setBulkResult] = useState<string | null>(null)
  // The section-level "all sources at once" run reports separately from the per-source one inside
  // the mapping editor — different scopes, so sharing one message would be confusing.
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

  function toggleMappingEditor(url: string): void {
    if (mappingOpenFor === url) {
      setMappingOpenFor(null)
      return
    }
    setMappingOpenFor(url)
    setGuideSearch('')
    setStreamSearch('')
    setSelectedGuideChannelId(null)
    setSelectedStreamId(null)
    setOnlyUnmatched(false)
    setUnmatchedIds(null)
    setBulkResult(null)
    // Index this source's guide once (see GuideIndex) — the suggestion ranking and the
    // unmatched-filter both read from it, and rebuilding per stream/keystroke would pay the
    // Unicode-normalization cost thousands of times.
    const sourceIndex = epgSourceLabels.indexOf(url)
    const guide = sourceIndex >= 0 ? epgSources[sourceIndex] : null
    setGuideIndex(guide ? buildGuideIndex(guide) : null)
    // The app-channel pane lists every channel the provider has, not just the currently-browsed
    // category — pull the full catalog on first open (cached in the store afterwards).
    void ensureChannelCatalog()
  }

  function removeSource(url: string): void {
    removeCustomEpgUrl(url)
    // A removed source can't keep its editor open — leaving it would show the picker for a guide
    // that is no longer in the pool.
    if (mappingOpenFor === url) setMappingOpenFor(null)
  }

  // Resolves the WHOLE catalog against the open source's guide to find channels that still have
  // no listings from it — the residue left after the automatic tiers and manual mappings (a
  // match with zero programmes counts as unresolved, same rule as the store's match report).
  // Runs from event handlers only, never per render: the walk is fine as a one-off on a click,
  // but it would make typing in the search box stutter.
  function refreshUnmatchedFilter(sourceUrl: string): void {
    const catalog = numericChannelCatalog ?? []
    const manual = new Map(
      settings.epgChannelMappings.filter((m) => m.sourceUrl === sourceUrl).map((m) => [m.streamId, m.guideChannelId])
    )
    const ids = new Set<number>()
    if (guideIndex) {
      for (const stream of catalog) {
        const resolved = resolveStreamToGuide(stream, guideIndex, manual.get(stream.stream_id))
        if (!resolved || resolved.programmeCount === 0) ids.add(stream.stream_id)
      }
    }
    setUnmatchedIds(ids)
  }

  function applyUnmatchedFilter(enabled: boolean, sourceUrl: string): void {
    setOnlyUnmatched(enabled)
    if (!enabled) {
      setUnmatchedIds(null)
      return
    }
    refreshUnmatchedFilter(sourceUrl)
  }

  // The section-level version: every user-added source, highest priority first, each only picking
  // up what nothing else has resolved or already claimed in this run.
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
  async function handleBulkApply(sourceUrl: string): Promise<void> {
    const percent = Math.round(bulkThreshold * 100)
    setBulkBusy(true)
    const result = await applySuggestedMappings(sourceUrl, bulkThreshold)
    setBulkBusy(false)
    const remaining = `${result.stillUnmatched} channel${result.stillUnmatched === 1 ? '' : 's'} still need${
      result.stillUnmatched === 1 ? 's' : ''
    } attention`
    setBulkResult(
      result.applied > 0
        ? `Applied ${result.applied} mapping${result.applied === 1 ? '' : 's'} at ${percent}% or better — ${remaining}.`
        : `Nothing scored ${percent}% or better — ${remaining}, or try a lower threshold.`
    )
    if (onlyUnmatched) refreshUnmatchedFilter(sourceUrl)
  }

  // One source's match summary, rendered on that source's own card (was a separate report block
  // below the list). The wording is unchanged — it is the app's own account of what matched and
  // how, and the numbers it quotes are the ones the tests pin.
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
  function renderMappingEditor(url: string): JSX.Element {
    const sourceIndex = epgSourceLabels.indexOf(url)
    const guide = sourceIndex >= 0 ? epgSources[sourceIndex] : null
    const guideChannels = guide ? Array.from(guide.channels.values()) : []
    const catalog = numericChannelCatalog ?? []
    const mappings = settings.epgChannelMappings.filter((m) => m.sourceUrl === url)

    const guideQuery = guideSearch.trim().toLowerCase()
    const matchingGuideChannels = guideQuery
      ? guideChannels.filter((c) => c.displayName.toLowerCase().includes(guideQuery) || c.id.toLowerCase().includes(guideQuery))
      : guideChannels
    const shownGuideChannels = matchingGuideChannels.slice(0, MAPPING_LIST_CAP)

    // The unmatched filter narrows the catalog BEFORE the search box applies, so typing inside
    // the filtered view searches only the channels that still need mapping.
    const baseStreams = onlyUnmatched && unmatchedIds ? catalog.filter((c) => unmatchedIds.has(c.stream_id)) : catalog
    const streamQuery = streamSearch.trim().toLowerCase()
    const matchingStreams = streamQuery
      ? baseStreams.filter((c) => c.name.toLowerCase().includes(streamQuery) || String(c.stream_id).includes(streamQuery))
      : baseStreams
    const shownStreams = matchingStreams.slice(0, MAPPING_LIST_CAP)

    // Ranked candidates for whichever app channel is currently selected — turns the residual
    // unmatched channels into one-click fixes instead of manual searching.
    const selectedStreamName = catalog.find((c) => c.stream_id === selectedStreamId)?.name ?? ''
    const suggestions =
      selectedStreamId !== null && guideIndex ? suggestGuideChannels(selectedStreamName, guideIndex, 3) : []

    function addMapping(): void {
      if (!selectedGuideChannelId || selectedStreamId === null) return
      // Display names are snapshots for the settings list only — matching itself is by ids.
      addEpgChannelMapping({
        sourceUrl: url,
        guideChannelId: selectedGuideChannelId,
        streamId: selectedStreamId,
        guideChannelName: guideChannels.find((c) => c.id === selectedGuideChannelId)?.displayName,
        streamName: catalog.find((c) => c.stream_id === selectedStreamId)?.name
      })
      // Mapping this channel resolves it — drop it from the filtered view so the user sees
      // their progress shrink instead of re-mapping something already done.
      if (unmatchedIds) {
        const next = new Set(unmatchedIds)
        next.delete(selectedStreamId)
        setUnmatchedIds(next)
      }
      setSelectedGuideChannelId(null)
      setSelectedStreamId(null)
      setGuideSearch('')
      setStreamSearch('')
    }

    return (
      <div className="epg-mapping-editor">
        {mappings.length > 0 ? (
          <ul className="epg-mapping-list">
            {mappings.map((m) => (
              <li key={m.streamId} className="epg-mapping-row">
                <span className="epg-mapping-pair">
                  {m.guideChannelName ?? m.guideChannelId} <span className="epg-mapping-arrow">→</span>{' '}
                  {m.streamName ?? `#${m.streamId}`}
                </span>
                <button className="danger-link" onClick={() => removeEpgChannelMapping(m.sourceUrl, m.streamId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="epg-mapping-empty">
            No manual mappings yet — this source&apos;s channels are matched by EPG id or name
            automatically. Map one below when that gets a channel wrong or misses it entirely.
          </p>
        )}
        {!guide ? (
          <p className="epg-mapping-empty">
            This source hasn&apos;t loaded a guide yet, so there&apos;s nothing to map — check its status above.
          </p>
        ) : (
          <>
            <div className="epg-mapping-picker">
              <div className="epg-mapping-pane">
                <label>Guide channel (this source)</label>
                <input
                  type="text"
                  placeholder={`Search ${guideChannels.length} guide channels…`}
                  value={guideSearch}
                  onChange={(e) => setGuideSearch(e.target.value)}
                />
                <div className="epg-mapping-options">
                  {shownGuideChannels.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={selectedGuideChannelId === c.id}
                      className={selectedGuideChannelId === c.id ? 'epg-mapping-option selected' : 'epg-mapping-option'}
                      onClick={() => setSelectedGuideChannelId(selectedGuideChannelId === c.id ? null : c.id)}
                    >
                      {c.displayName} <small>{c.id}</small>
                    </button>
                  ))}
                  {matchingGuideChannels.length === 0 && <p className="epg-mapping-empty">No guide channels match.</p>}
                  {matchingGuideChannels.length > MAPPING_LIST_CAP && (
                    <p className="epg-mapping-empty">
                      Showing the first {MAPPING_LIST_CAP} of {matchingGuideChannels.length} — refine the search to narrow it down.
                    </p>
                  )}
                </div>
              </div>
              <div className="epg-mapping-pane">
                <label>App channel (your provider)</label>
                {connectionStatus !== 'ready' ? (
                  <p className="epg-mapping-empty">Connect to a provider to pick channels.</p>
                ) : numericChannelCatalog === null ? (
                  <p className="epg-mapping-empty">Loading your channel list…</p>
                ) : (
                  <>
                    <label className="epg-mapping-filter">
                      <input
                        type="checkbox"
                        checked={onlyUnmatched}
                        onChange={(e) => applyUnmatchedFilter(e.target.checked, url)}
                      />
                      Only channels with no listings from this source
                      {onlyUnmatched && unmatchedIds ? ` (${unmatchedIds.size})` : ''}
                    </label>
                    <div className="epg-bulk-apply">
                      <label>
                        Auto-map suggestions at
                        <select value={bulkThreshold} onChange={(e) => setBulkThreshold(Number(e.target.value))}>
                          {BULK_THRESHOLDS.map((value) => (
                            <option key={value} value={value}>
                              {Math.round(value * 100)}%
                            </option>
                          ))}
                        </select>
                        or better
                      </label>
                      <button className="secondary-button" disabled={bulkBusy} onClick={() => void handleBulkApply(url)}>
                        {bulkBusy ? 'Applying…' : 'Apply to all unmatched'}
                      </button>
                    </div>
                    {bulkResult && <p className="epg-bulk-result">{bulkResult}</p>}
                    <input
                      type="text"
                      placeholder={`Search ${baseStreams.length} channels…`}
                      value={streamSearch}
                      onChange={(e) => setStreamSearch(e.target.value)}
                    />
                    <div className="epg-mapping-options">
                      {shownStreams.map((c) => (
                        <button
                          key={c.stream_id}
                          type="button"
                          aria-pressed={selectedStreamId === c.stream_id}
                          className={selectedStreamId === c.stream_id ? 'epg-mapping-option selected' : 'epg-mapping-option'}
                          onClick={() => setSelectedStreamId(selectedStreamId === c.stream_id ? null : c.stream_id)}
                        >
                          {c.name} <small>#{c.stream_id}</small>
                        </button>
                      ))}
                      {matchingStreams.length === 0 && (
                        <p className="epg-mapping-empty">
                          {onlyUnmatched
                            ? 'No channels match — every channel in this filter already has listings from this source.'
                            : 'No channels match.'}
                        </p>
                      )}
                      {matchingStreams.length > MAPPING_LIST_CAP && (
                        <p className="epg-mapping-empty">
                          Showing the first {MAPPING_LIST_CAP} of {matchingStreams.length} — refine the search to narrow it down.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
            {selectedStreamId !== null && (
              <div className="epg-mapping-suggestions">
                <span className="epg-mapping-suggestions-label">
                  Suggested guide channels for “{selectedStreamName}”:
                </span>
                {suggestions.map((candidate) => (
                  <button
                    key={candidate.channelId}
                    type="button"
                    className={
                      selectedGuideChannelId === candidate.channelId
                        ? 'epg-mapping-suggestion selected'
                        : 'epg-mapping-suggestion'
                    }
                    onClick={() => setSelectedGuideChannelId(candidate.channelId)}
                    title={`Guide channel id: ${candidate.channelId}`}
                  >
                    {candidate.displayName} <small>{Math.round(candidate.score * 100)}%</small>
                  </button>
                ))}
                {suggestions.length === 0 && (
                  <span className="epg-mapping-empty">No close match — search the guide list on the left.</span>
                )}
              </div>
            )}
            <div className="pin-set-row epg-mapping-add-row">
              <button disabled={!selectedGuideChannelId || selectedStreamId === null} onClick={addMapping}>
                Add mapping
              </button>
            </div>
            <p className="settings-hint">
              Manual mappings override the automatic EPG-id, name, and relaxed matching for this
              source — tick &quot;only channels with no listings&quot; to work through whatever the
              automatic joins didn&apos;t resolve, and pick a suggestion to fill the guide side in
              one click. Your provider&apos;s own per-channel listings still win wherever the
              provider sends them — a mapping fills in the later days and the channels the
              provider doesn&apos;t cover.
            </p>
          </>
        )}
      </div>
    )
  }

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
            return (
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

          {epgSourcesStatus === 'loading' && <p className="settings-hint">Loading guide sources…</p>}
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
