import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, PROVIDER_GUIDE_LABEL } from '../store/useAppStore'
import { buildGuideIndex, suggestGuideChannels, type GuideIndex } from '../lib/epg'
import { pickDefaultMatchSource, tierCandidates, POSSIBLE_MATCH_SCORE } from '../lib/channelMatch'

// The panel's own lists cap at the same size the old guide-page editor did — a full provider guide
// is tens of thousands of entries and an unbounded listbox is unusable DOM. The expander exists
// precisely for when the suggestions do not contain the right answer.
const PANEL_LIST_CAP = 60
// How deep the suggestion list reaches: deliberately below the automatic joins' floor, because a
// person choosing from a labelled list can accept what an automatic join must refuse. Each row
// carries its score so a weak candidate is visibly weak.
const PANEL_MIN_SCORE = POSSIBLE_MATCH_SCORE

/**
 * Matching one channel, from start to finish, in one small panel.
 *
 * Replaces the flow reported as "i dont like the layout for individual channel matching, its too
 * much": a two-pane editor inside the guide page where the app channel had to be found in one pane
 * and the guide channel in another. This panel is opened from a channel's right-click menu
 * ("EPG match…"), already aimed at that channel, and shows exactly three things: what is mapped for
 * it now, the shortlist of close guide-channel matches (strong ones first, weaker ones labelled
 * with their score), and — behind an expander — all of that source's guide channels for the cases
 * the shortlist misses. Selecting the source is part of it, per the same request.
 *
 * Deliberately absent from here: the bulk-apply controls and the per-source match reports. Those
 * are guide-wide concerns that belong on the guide page, not inside a single channel's decision.
 */
export function ChannelMatchModal(): JSX.Element | null {
  const target = useAppStore((s) => s.epgMatchTarget)
  const clearTarget = useAppStore((s) => s.clearEpgMatchTarget)
  const settings = useAppStore((s) => s.settings)
  const epgSources = useAppStore((s) => s.epgSources)
  const epgSourceLabels = useAppStore((s) => s.epgSourceLabels)
  const epgSourceByStream = useAppStore((s) => s.epgSourceByStream)
  const liveStreams = useAppStore((s) => s.liveStreams)
  const addEpgChannelMapping = useAppStore((s) => s.addEpgChannelMapping)
  const removeEpgChannelMapping = useAppStore((s) => s.removeEpgChannelMapping)
  const openGuide = useAppStore((s) => s.openGuide)

  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  // One index per source, built on first use and kept while the app lives — building one is a walk
  // over the entire guide, so per-open rebuilding would pay that cost every click.
  const indexCache = useRef(new Map<string, GuideIndex>())

  const channel = useMemo(
    () => (target ? liveStreams.find((c) => c.stream_id === target.streamId) ?? null : null),
    [target, liveStreams]
  )
  const channelName = channel?.name ?? target?.streamName ?? ''
  const supplier = target ? epgSourceByStream[target.streamId] ?? null : null

  // Mappable sources: everything except the provider's own guide (not manually mappable — its
  // channel ids are what epg_channel_id already refers to; see EpgChannelMapping).
  const mappableSources = useMemo(
    () => epgSourceLabels.filter((label) => label !== PROVIDER_GUIDE_LABEL),
    [epgSourceLabels]
  )
  const hiddenSources = settings.hiddenEpgSourceUrls

  // Default the source on open (or when the target changes): the current supplier if it is one of
  // the custom sources, else the first visible one — see pickDefaultMatchSource.
  useEffect(() => {
    if (!target) return
    setSelectedGuideId(null)
    setSearch('')
    setShowAll(false)
    setSourceUrl(pickDefaultMatchSource(mappableSources, supplier, PROVIDER_GUIDE_LABEL, hiddenSources))
  }, [target]) // deliberately narrow: re-running on every settings tick would reset the user's picks

  const index = useMemo(() => {
    if (!sourceUrl) return null
    const cached = indexCache.current.get(sourceUrl)
    if (cached) return cached
    const i = epgSourceLabels.indexOf(sourceUrl)
    if (i < 0 || !epgSources[i]) return null
    const built = buildGuideIndex(epgSources[i])
    indexCache.current.set(sourceUrl, built)
    return built
  }, [sourceUrl, epgSourceLabels, epgSources])

  const guideChannels = useMemo(() => (index ? Array.from(index.channels.values()) : []), [index])
  const suggestions = useMemo(
    () => (channelName && index ? tierCandidates(suggestGuideChannels(channelName, index, 8, PANEL_MIN_SCORE)) : []),
    [channelName, index]
  )

  const query = search.trim().toLowerCase()
  const listRows = useMemo(() => {
    const rows = query
      ? guideChannels.filter((c) => c.displayName.toLowerCase().includes(query) || c.id.toLowerCase().includes(query))
      : guideChannels
    return rows.slice(0, PANEL_LIST_CAP)
  }, [guideChannels, query])

  const mappedHere = settings.epgChannelMappings.filter((m) => m.sourceUrl === sourceUrl)
  const mappedForChannel = mappedHere.find((m) => m.streamId === target?.streamId) ?? null

  if (!target) return null

  return (
    <div className="modal-overlay" onClick={() => clearTarget()}>
      <div className="modal-card channel-match-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Channel match</h2>
            <p className="guide-subtitle">{channelName}</p>
          </div>
          <button className="modal-close" onClick={() => clearTarget()} title="Close">
            ✕
          </button>
        </div>

        {/* What this channel has right now — the first thing to check, because half the time the
            listings are fine and the mapping is not the problem. */}
        <p className="channel-match-state">
          {supplier ? (
            <>
              Listings currently from <strong>{supplier}</strong>
            </>
          ) : (
            'No listings source is supplying this channel'
          )}
        </p>

        {mappableSources.length === 0 ? (
          <p className="channel-match-state">
            There are no guide sources to match against yet — add one on the Guide &amp; EPG page
            (Open guide settings below).
          </p>
        ) : (
          <>
            <label className="channel-match-source">
              <span>Match against</span>
              <select
                value={sourceUrl ?? ''}
                onChange={(e) => {
                  setSourceUrl(e.target.value)
                  setSelectedGuideId(null)
                }}
              >
                {mappableSources.map((url) => (
                  <option key={url} value={url}>
                    {url}
                    {hiddenSources.includes(url) ? ' (hidden)' : ''}
                  </option>
                ))}
              </select>
            </label>

            {mappedForChannel && (
              <p className="channel-match-current">
                Mapped to <strong>{mappedForChannel.guideChannelName ?? mappedForChannel.guideChannelId}</strong>
                {mappedForChannel.guideChannelId !== mappedForChannel.guideChannelName
                  ? ` (${mappedForChannel.guideChannelId})`
                  : ''}{' '}
                — this overrides the automatic joins.
              </p>
            )}

            {guideChannels.length === 0 ? (
              <p className="channel-match-state">
                This source hasn&apos;t loaded a guide, so there is nothing to match against yet.
              </p>
            ) : (
              <>
                <div className="channel-match-suggestions">
                  <span className="channel-match-suggestions-label">
                    Suggested guide channels{query ? ` for “${channelName}”` : ''}
                  </span>
                  {suggestions.map((candidate) => (
                    <button
                      key={candidate.channelId}
                      type="button"
                      aria-pressed={selectedGuideId === candidate.channelId}
                      className={
                        selectedGuideId === candidate.channelId
                          ? 'channel-match-option selected'
                          : 'channel-match-option'
                      }
                      onClick={() => setSelectedGuideId(selectedGuideId === candidate.channelId ? null : candidate.channelId)}
                    >
                      <span className="channel-match-option-name">
                        {candidate.displayName} <small>{candidate.channelId}</small>
                      </span>
                      <span
                        className={`channel-match-score ${
                          candidate.tier === 'strong' ? 'channel-match-score--strong' : 'channel-match-score--possible'
                        }`}
                      >
                        {Math.round(candidate.score * 100)}% {candidate.tier}
                      </span>
                    </button>
                  ))}
                  {suggestions.length === 0 && (
                    <p className="channel-match-empty">
                      No close match — use “show all guide channels” below and search.
                    </p>
                  )}
                </div>

                {!showAll && (
                  <button className="channel-match-expand" onClick={() => setShowAll(true)}>
                    Show all {guideChannels.length} guide channels for this source
                  </button>
                )}
                {showAll && (
                  <>
                    <input
                      type="text"
                      placeholder={`Search ${guideChannels.length} guide channels…`}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <div className="channel-match-options">
                      {listRows.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={selectedGuideId === c.id}
                          className={
                            selectedGuideId === c.id ? 'channel-match-option selected' : 'channel-match-option'
                          }
                          onClick={() => setSelectedGuideId(selectedGuideId === c.id ? null : c.id)}
                        >
                          <span className="channel-match-option-name">
                            {c.displayName} <small>{c.id}</small>
                          </span>
                        </button>
                      ))}
                      {listRows.length === 0 && <p className="channel-match-empty">No guide channels match.</p>}
                    </div>
                  </>
                )}

                <div className="pin-set-row channel-match-add-row">
                  <button
                    disabled={!selectedGuideId}
                    onClick={() => {
                      if (!target || !sourceUrl || !selectedGuideId) return
                      addEpgChannelMapping({
                        sourceUrl,
                        guideChannelId: selectedGuideId,
                        streamId: target.streamId,
                        guideChannelName: guideChannels.find((c) => c.id === selectedGuideId)?.displayName,
                        streamName: channelName || undefined
                      })
                      clearTarget()
                    }}
                  >
                    {mappedForChannel ? 'Replace mapping' : 'Add mapping'}
                  </button>
                  {mappedForChannel && (
                    <button
                      className="danger-link"
                      onClick={() => {
                        if (!sourceUrl) return
                        removeEpgChannelMapping(sourceUrl, target.streamId)
                        clearTarget()
                      }}
                    >
                      Remove mapping
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* The guide page is where sources are added and hidden — one click away, and opening it
            clears this panel's target (see openGuide in the store), so the two never stack. */}
        <button className="channel-match-open-guide" onClick={() => openGuide()}>
          Open guide settings
        </button>
      </div>
    </div>
  )
}
