import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { BufferProfile, ClockFormat } from '../lib/types'

export function SettingsPage(): JSX.Element | null {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const categories = useAppStore((s) => s.categories)
  const viewMode = useAppStore((s) => s.viewMode)
  const setCategoryLocked = useAppStore((s) => s.setCategoryLocked)

  const [pinDraft, setPinDraft] = useState('')

  if (!settingsOpen) return null

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
                  {categories.map((cat) => (
                    <li key={cat.category_id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.lockedCategoryIds.includes(cat.category_id)}
                          onChange={(e) => setCategoryLocked(cat.category_id, e.target.checked)}
                        />
                        {cat.category_name}
                      </label>
                    </li>
                  ))}
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
      </div>
    </div>
  )
}
