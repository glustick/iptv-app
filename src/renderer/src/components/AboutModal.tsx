import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import appIcon from '../assets/icon.png'

interface AppInfo {
  name: string
  version: string
  buildNumber: number
}

export function AboutModal(): JSX.Element | null {
  const aboutOpen = useAppStore((s) => s.aboutOpen)
  const closeAbout = useAppStore((s) => s.closeAbout)
  const checkForUpdates = useAppStore((s) => s.checkForUpdates)
  const [info, setInfo] = useState<AppInfo | null>(null)
  // Local, not store state — this only ever means "the check() call this button made hasn't
  // resolved yet," not "an update was found" (that's updateInfo, surfaced by UpdatePrompt
  // instead, wherever the user is, not just while this modal happens to be open).
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!aboutOpen) return
    window.api.app.getInfo().then(setInfo).catch((err) => console.error('[about] failed to load app info:', err))
  }, [aboutOpen])

  if (!aboutOpen) return null

  async function handleCheckForUpdates(): Promise<void> {
    setChecking(true)
    try {
      await checkForUpdates()
    } catch (err) {
      console.error('[about] update check failed:', err)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={closeAbout}>
      <div className="modal-card about-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>About</h2>
          <button className="modal-close" onClick={closeAbout}>
            ✕
          </button>
        </div>
        <div className="about-body">
          <img className="about-icon" src={appIcon} alt="" />
          <h3 className="about-name">{info?.name ?? 'AllisonIPTV'}</h3>
          <dl className="about-meta">
            <dt>Version</dt>
            <dd>{info?.version ?? '—'}</dd>
            <dt>Build</dt>
            <dd>{info?.buildNumber ?? '—'}</dd>
          </dl>
          <button
            type="button"
            className="secondary-button about-check-updates"
            onClick={() => void handleCheckForUpdates()}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Check for Updates'}
          </button>
        </div>
      </div>
    </div>
  )
}
