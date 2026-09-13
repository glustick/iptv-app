import { useState } from 'react'
import { useAppStore, PROVIDER_GUIDE_LABEL } from '../store/useAppStore'
import { unionEpgSourceUrls } from '../lib/epg'
import type { BufferProfile, ClockFormat, VpnProfile } from '../lib/types'

interface VpnDraft {
  name: string
  username: string
  password: string
}

// The mapping editor's search lists render at most this many rows — a full provider catalog
// (or a country-wide iptv-org guide) is thousands of entries, and an unbounded listbox is
// unusable DOM. The hint below each list says when the search needs narrowing.
const MAPPING_LIST_CAP = 60

export function SettingsPage(): JSX.Element | null {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const categories = useAppStore((s) => s.categories)
  const viewMode = useAppStore((s) => s.viewMode)
  const setCategoryLocked = useAppStore((s) => s.setCategoryLocked)
  const vpnStatus = useAppStore((s) => s.vpnStatus)
  const vpnErrorMessage = useAppStore((s) => s.vpnErrorMessage)
  const addVpnProfile = useAppStore((s) => s.addVpnProfile)
  const updateVpnProfile = useAppStore((s) => s.updateVpnProfile)
  const removeVpnProfile = useAppStore((s) => s.removeVpnProfile)
  const activateVpnProfile = useAppStore((s) => s.activateVpnProfile)
  const deactivateVpnProfile = useAppStore((s) => s.deactivateVpnProfile)
  const exportBackup = useAppStore((s) => s.exportBackup)
  const importBackup = useAppStore((s) => s.importBackup)
  const addCustomEpgUrl = useAppStore((s) => s.addCustomEpgUrl)
  const removeCustomEpgUrl = useAppStore((s) => s.removeCustomEpgUrl)
  const epgSourcesStatus = useAppStore((s) => s.epgSourcesStatus)
  const epgSourceIssues = useAppStore((s) => s.epgSourceIssues)
  const epgSourceMatchStats = useAppStore((s) => s.epgSourceMatchStats)
  const epgSources = useAppStore((s) => s.epgSources)
  const epgSourceLabels = useAppStore((s) => s.epgSourceLabels)
  const numericChannelCatalog = useAppStore((s) => s.numericChannelCatalog)
  const connectionStatus = useAppStore((s) => s.status)
  const addEpgChannelMapping = useAppStore((s) => s.addEpgChannelMapping)
  const removeEpgChannelMapping = useAppStore((s) => s.removeEpgChannelMapping)
  const ensureChannelCatalog = useAppStore((s) => s.ensureChannelCatalog)

  const [pinDraft, setPinDraft] = useState('')
  // Only set when opening the log fails (no active connection, or the file hasn't been written
  // yet) — shell.openPath() handles the success case itself by opening the OS's default viewer,
  // so there's nothing to show here when it works.
  const [vpnLogMessage, setVpnLogMessage] = useState<string | null>(null)
  // Keyed by profile id — mirrors the PIN's own draft-then-explicit-save pattern (avoids
  // encrypting/writing to disk on every keystroke), just one draft per saved VPN profile
  // instead of a single global one.
  const [vpnDrafts, setVpnDrafts] = useState<Record<string, VpnDraft>>({})
  // Only one profile's edit form is ever open at a time — rows are compact by default so a
  // list of many saved configs doesn't turn into a wall of always-expanded forms.
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [epgUrlDraft, setEpgUrlDraft] = useState('')
  // Manual channel-mapping editor state — one source's editor open at a time (keyed by the
  // source's URL); searches and picks reset whenever a different editor opens so stale
  // selections from source A can't be submitted into source B.
  const [mappingOpenFor, setMappingOpenFor] = useState<string | null>(null)
  const [guideSearch, setGuideSearch] = useState('')
  const [streamSearch, setStreamSearch] = useState('')
  const [selectedGuideChannelId, setSelectedGuideChannelId] = useState<string | null>(null)
  const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null)

  if (!settingsOpen) return null

  // The EPG sources list is the UNION of persisted and currently-live sources (see
  // unionEpgSourceUrls) — anything the app is still fetching stays listed and removable even
  // if a state round-trip bug ever leaves it out of settings.
  const listedSources = unionEpgSourceUrls(settings.customEpgUrls, epgSourceLabels, PROVIDER_GUIDE_LABEL)

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
    // The app-channel pane lists every channel the provider has, not just the currently-browsed
    // category — pull the full catalog on first open (cached in the store afterwards).
    void ensureChannelCatalog()
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

    const streamQuery = streamSearch.trim().toLowerCase()
    const matchingStreams = streamQuery
      ? catalog.filter((c) => c.name.toLowerCase().includes(streamQuery) || String(c.stream_id).includes(streamQuery))
      : catalog
    const shownStreams = matchingStreams.slice(0, MAPPING_LIST_CAP)

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
                    <input
                      type="text"
                      placeholder={`Search ${catalog.length} channels…`}
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
                      {matchingStreams.length === 0 && <p className="epg-mapping-empty">No channels match.</p>}
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
            <div className="pin-set-row epg-mapping-add-row">
              <button disabled={!selectedGuideChannelId || selectedStreamId === null} onClick={addMapping}>
                Add mapping
              </button>
            </div>
            <p className="settings-hint">
              Manual mappings override the automatic EPG-id and name matching for this source.
              Your provider&apos;s own per-channel listings still win wherever the provider sends
              them — a mapping fills in the later days and channels the provider doesn&apos;t cover.
            </p>
          </>
        )}
      </div>
    )
  }

  async function handleExportBackup(): Promise<void> {
    const result = await exportBackup()
    if (result.ok) {
      setBackupMessage(result.path ? `Backup saved to ${result.path}` : null)
    } else {
      setBackupMessage(`Export failed: ${result.error ?? 'unknown error'}`)
    }
  }

  async function handleImportBackup(): Promise<void> {
    // A real restore, not a merge — replaces whatever's currently saved (see importBackup's own
    // comment), so this needs the same explicit confirmation as any other irreversible action in
    // this app (see History's Clear All).
    if (
      !window.confirm(
        'Importing a backup will replace your current profiles, favorites, history, and settings, then reload the app. Continue?'
      )
    ) {
      return
    }
    const result = await importBackup()
    // A successful import reloads the whole app immediately (see importBackup) — nothing here
    // ever actually renders once that happens. Only a failure or a cancelled file picker reach
    // this line at all.
    if (!result.ok) setBackupMessage(`Import failed: ${result.error ?? 'unknown error'}`)
  }

  function draftFor(profile: VpnProfile): VpnDraft {
    return vpnDrafts[profile.id] ?? { name: profile.name, username: profile.username ?? '', password: profile.password ?? '' }
  }

  function setDraft(id: string, patch: Partial<VpnDraft>, profile: VpnProfile): void {
    setVpnDrafts((prev) => ({ ...prev, [id]: { ...draftFor(profile), ...patch } }))
  }

  function setBufferProfile(bufferProfile: BufferProfile): void {
    updateSettings({ bufferProfile })
  }

  function setClockFormat(clockFormat: ClockFormat): void {
    updateSettings({ clockFormat })
  }

  function savePin(): void {
    updateSettings({ parentalPin: pinDraft.trim() || null })
    setPinDraft('')
  }

  function clearPin(): void {
    updateSettings({ parentalPin: null, lockedCategoryIds: [] })
  }

  async function viewVpnLog(): Promise<void> {
    const result = await window.api.vpn.openLog()
    setVpnLogMessage(result.ok ? null : (result.message ?? 'Could not open the log file.'))
  }

  async function addVpnConfigFile(): Promise<void> {
    const path = await window.api.vpn.selectConfigFile()
    if (!path) return
    // Not a filesystem call — just the last path segment for display/default naming, so the
    // settings form shows a readable filename instead of the full absolute path.
    const configName = path.split(/[/\\]/).pop() ?? path
    await addVpnProfile({ name: configName, configPath: path, configName, username: null, password: null })
  }

  function startEditingVpnProfile(profile: VpnProfile): void {
    // Reset to the profile's actual saved values rather than whatever draft might be left
    // over from a previous edit that was cancelled without saving.
    setVpnDrafts((prev) => ({
      ...prev,
      [profile.id]: { name: profile.name, username: profile.username ?? '', password: profile.password ?? '' }
    }))
    setEditingProfileId(profile.id)
  }

  function saveVpnProfileDraft(profile: VpnProfile): void {
    const draft = draftFor(profile)
    void updateVpnProfile(profile.id, {
      name: draft.name.trim() || profile.configName,
      username: draft.username.trim() || null,
      password: draft.password.trim() || null
    })
    setEditingProfileId(null)
  }

  return (
    <div className="modal-overlay" onClick={closeSettings}>
      <div className="modal-card settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={closeSettings}>
            ✕
          </button>
        </div>

        <section className="settings-section">
          <h3>Playback buffering</h3>
          <div className="settings-choice">
            <button
              className={settings.bufferProfile === 'smooth' ? 'choice-button active' : 'choice-button'}
              onClick={() => setBufferProfile('smooth')}
            >
              Smooth (recommended)
            </button>
            <button
              className={settings.bufferProfile === 'lowLatency' ? 'choice-button active' : 'choice-button'}
              onClick={() => setBufferProfile('lowLatency')}
            >
              Low latency
            </button>
          </div>
          <p className="settings-hint">
            Smooth buffers further ahead to avoid stalls on inconsistent connections. Low latency stays closer to
            the live edge but is more prone to rebuffering.
          </p>
        </section>

        <section className="settings-section">
          <h3>Clock format</h3>
          <div className="settings-choice">
            <button
              className={settings.clockFormat === '12h' ? 'choice-button active' : 'choice-button'}
              onClick={() => setClockFormat('12h')}
            >
              12-hour
            </button>
            <button
              className={settings.clockFormat === '24h' ? 'choice-button active' : 'choice-button'}
              onClick={() => setClockFormat('24h')}
            >
              24-hour
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h3>Parental controls</h3>
          {settings.parentalPin ? (
            <>
              <p className="settings-hint">PIN is set. Lock categories below from the {viewMode} section.</p>
              <button className="secondary-button" onClick={clearPin}>
                Remove PIN &amp; unlock all categories
              </button>
              {categories.length > 0 && (
                <ul className="lock-list">
                  {categories.map((cat) => {
                    // Namespaced by section (the current tab) since Xtream doesn't guarantee
                    // category_id uniqueness across Live/Movies/Series — see useAppStore.
                    const lockKey = `${viewMode}:${cat.category_id}`
                    return (
                      <li key={cat.category_id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={settings.lockedCategoryIds.includes(lockKey)}
                            onChange={(e) => setCategoryLocked(lockKey, e.target.checked)}
                          />
                          {cat.category_name}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          ) : (
            <div className="pin-set-row">
              <input
                type="password"
                inputMode="numeric"
                placeholder="Set a PIN"
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value)}
              />
              <button onClick={savePin} disabled={!pinDraft.trim()}>
                Set PIN
              </button>
            </div>
          )}
        </section>

        <section className="settings-section">
          <h3>EPG sources</h3>
          <p className="settings-hint">
            Providers only send listings for roughly the rest of today per channel. Adding a full
            guide (any XMLTV URL, plain or .xml.gz — e.g. one of iptv-org&apos;s country feeds at
            iptv-org.github.io/epg) fills in later days and channels your provider doesn&apos;t
            cover. Plain-text or PDF schedules can&apos;t be parsed — only the XMLTV form, however
            the file is named. Channels are matched by EPG id first, then by name — and a channel
            you map manually overrides both when the automatic joins get one wrong or miss it.
            Your provider&apos;s own listings always win where they exist.
          </p>
          {listedSources.length > 0 && (
            <ul className="lock-list">
              {listedSources.map((url) => {
                const mappings = settings.epgChannelMappings.filter((m) => m.sourceUrl === url)
                return (
                  <li key={url}>
                    <label>
                      <span className="epg-source-url">{url}</span>
                      <button
                        className="secondary-button"
                        onClick={() => toggleMappingEditor(url)}
                        title="Manually map this source's guide channels to your provider's channels"
                      >
                        {mappingOpenFor === url ? 'Close mapping' : 'Map channels'}
                        {mappings.length > 0 ? ` (${mappings.length})` : ''}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => removeCustomEpgUrl(url)}
                        title="Remove this EPG source"
                      >
                        Remove
                      </button>
                    </label>
                    {epgSourceIssues[url] && <p className="epg-source-issue">⚠ {epgSourceIssues[url]}</p>}
                    {mappingOpenFor === url && renderMappingEditor(url)}
                  </li>
                )
              })}
            </ul>
          )}
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
          {epgSourceMatchStats.length > 0 && (
            <div className="epg-match-report">
              <h4>Guide matching</h4>
              {epgSourceMatchStats.map((stat) => (
                <div key={stat.source} className="epg-match-row">
                  <p className="epg-match-line">
                    {stat.available ? (
                      stat.loadedChannels === 0 ? (
                        <span>
                          <strong>{stat.source}</strong> — loaded. Open a channel category to see its matching.
                        </span>
                      ) : (
                        <span>
                          <strong>{stat.source}</strong> — matched {stat.matched} of {stat.loadedChannels} loaded
                          channels ({stat.byId} by EPG id, {stat.byName} by name
                          {stat.byManual > 0 ? `, ${stat.byManual} by manual mapping` : ''})
                        </span>
                      )
                    ) : (
                      <span>
                        <strong>{stat.source}</strong> — unavailable (blocked or disabled by this provider)
                      </span>
                    )}
                  </p>
                  {stat.available && stat.matched < stat.loadedChannels && stat.loadedChannels > 0 && (
                    <p className="epg-match-unmatched" title="First 30 unmatched channel names in the loaded category">
                      No match for: {stat.unmatchedNames.join(', ')}
                      {stat.loadedChannels - stat.matched > stat.unmatchedNames.length
                        ? ` … and ${stat.loadedChannels - stat.matched - stat.unmatchedNames.length} more`
                        : ''}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          {epgSourcesStatus === 'loading' && <p className="settings-hint">Loading guide sources…</p>}
        </section>

<section className="settings-section">
          <h3>VPN</h3>
          <p className="settings-hint">
            Requires OpenVPN installed on this machine — this app doesn't bundle it. Only this app's own
            connection to your Xtream server uses the tunnel; everything else on this computer keeps using
            your normal connection. Connecting prompts for your OS password or admin approval, since creating a
            tunnel requires elevated privileges. Only one VPN configuration can be active at a time — activating
            a different one disconnects whichever is currently running first.
          </p>
          <button className="secondary-button" onClick={() => void addVpnConfigFile()}>
            + Add VPN configuration
          </button>
          {settings.vpnProfiles.length > 0 && (
            <ul className="vpn-profile-list">
              {settings.vpnProfiles.map((profile) => {
                const isActive = settings.activeVpnProfileId === profile.id
                const isEditing = editingProfileId === profile.id
                const draft = draftFor(profile)
                return (
                  <li key={profile.id} className="vpn-profile-row">
                    <div className="vpn-profile-compact">
                      {isActive && (
                        <span
                          className={`vpn-dot vpn-dot--${vpnStatus}`}
                          title={vpnStatus === 'error' ? (vpnErrorMessage ?? 'Error') : vpnStatus}
                        />
                      )}
                      <span className="vpn-profile-name-label" title={profile.configName}>
                        {profile.name}
                      </span>
                      <div className="vpn-profile-actions">
                        {isActive ? (
                          <button className="secondary-button" onClick={() => void deactivateVpnProfile()}>
                            Deactivate
                          </button>
                        ) : (
                          <button className="secondary-button" onClick={() => void activateVpnProfile(profile.id)}>
                            Activate
                          </button>
                        )}
                        {/* Only the active profile has a live temp dir (and log file) to show —
                            cleaned up as soon as it's deactivated or a connection attempt fails. */}
                        {isActive && (
                          <button className="secondary-button" onClick={() => void viewVpnLog()}>
                            View Log
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          onClick={() => (isEditing ? setEditingProfileId(null) : startEditingVpnProfile(profile))}
                        >
                          {isEditing ? 'Close' : 'Edit'}
                        </button>
                        <button className="danger-link" onClick={() => void removeVpnProfile(profile.id)}>
                          Remove
                        </button>
                      </div>
                    </div>
                    {isActive && vpnStatus === 'error' && <p className="settings-hint">Error: {vpnErrorMessage}</p>}
                    {isActive && vpnLogMessage && <p className="settings-hint">{vpnLogMessage}</p>}
                    {isEditing && (
                      <div className="vpn-profile-edit">
                        <label>
                          Name
                          <input
                            value={draft.name}
                            onChange={(e) => setDraft(profile.id, { name: e.target.value }, profile)}
                          />
                        </label>
                        <span className="vpn-config-name">{profile.configName}</span>
                        <div className="pin-set-row">
                          <input
                            type="text"
                            placeholder="Username (if required)"
                            value={draft.username}
                            onChange={(e) => setDraft(profile.id, { username: e.target.value }, profile)}
                          />
                          <input
                            type="password"
                            placeholder="Password (if required)"
                            value={draft.password}
                            onChange={(e) => setDraft(profile.id, { password: e.target.value }, profile)}
                          />
                          <button onClick={() => saveVpnProfileDraft(profile)}>Save</button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="settings-section">
          <h3>Backup</h3>
          <p className="settings-hint">
            Export saves your profiles, favorites, history, and settings to a single file — useful before
            reinstalling this app or moving to a different computer. The file contains your provider login
            credentials in plain text (the same way this app already stores them), so keep it somewhere safe.
            Importing replaces everything currently saved here and reloads the app.
          </p>
          <div className="settings-choice">
            <button className="secondary-button" onClick={() => void handleExportBackup()}>
              Export Backup…
            </button>
            <button className="secondary-button" onClick={() => void handleImportBackup()}>
              Import Backup…
            </button>
          </div>
          {backupMessage && <p className="settings-hint">{backupMessage}</p>}
        </section>
      </div>
    </div>
  )
}
