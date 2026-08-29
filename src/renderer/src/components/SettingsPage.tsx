import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { BufferProfile, ClockFormat, VpnProfile } from '../lib/types'

interface VpnDraft {
  name: string
  username: string
  password: string
}

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

  if (!settingsOpen) return null

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
      </div>
    </div>
  )
}
