import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { formatReleaseNotes } from '../lib/releaseNotes'
import { downloadPageUrl, updateModeForPlatform, type UpdateMode } from '../lib/updateMode'

// Backed by autoUpdater in src/main/index.ts, which checks the GitHub Releases this app's own
// CI publishes to (see .github/workflows/release.yml). autoDownload is off there specifically so
// this prompt gets to ask first — an update-available check alone never spends the user's
// bandwidth, only clicking "Update Now" here does.
export function UpdatePrompt(): JSX.Element | null {
  const updateInfo = useAppStore((s) => s.updateInfo)
  const downloadPercent = useAppStore((s) => s.updateDownloadPercent)
  const downloaded = useAppStore((s) => s.updateDownloaded)
  const error = useAppStore((s) => s.updateError)
  const dismissed = useAppStore((s) => s.updateDismissed)
  const downloadUpdate = useAppStore((s) => s.downloadUpdate)
  const installUpdate = useAppStore((s) => s.installUpdate)
  const dismissUpdatePrompt = useAppStore((s) => s.dismissUpdatePrompt)

  // Which platform this is decides *how* an update can be taken: Windows and Linux apply an
  // unsigned update themselves (confirmed working), macOS cannot — see lib/updateMode.ts for the
  // reasoning, which belongs to a recorded decision rather than to a technical accident.
  const [mode, setMode] = useState<UpdateMode>('auto')
  useEffect(() => {
    // Optional-chained throughout: this component must never take the window down if the preload
    // bridge is missing (a component test, or a renderer loaded outside Electron). The default is
    // `auto`, i.e. the in-app updater, so nothing is hidden by failing to ask.
    try {
      void window.api?.app
        ?.getInfo()
        ?.then((info) => setMode(updateModeForPlatform(info?.platform)))
        .catch(() => {})
    } catch {
      // Bridge absent — keep the default.
    }
  }, [])

  // A downloaded update resurfaces regardless of an earlier "Later" on the plain available
  // prompt (see the store's onDownloaded, which resets updateDismissed itself) — from here,
  // dismissed is a plain, uniform toggle for whichever prompt is currently showing.
  if (!updateInfo || dismissed) return null

  const downloading = downloadPercent !== null
  // Plain-text rendering of the release's own notes (see lib/releaseNotes.ts) — shown in both the
  // "available" and "ready to install" states, i.e. wherever the user is being asked to care.
  const notes = updateInfo.releaseNotes ? formatReleaseNotes(updateInfo.releaseNotes) : ''

  return (
    <div className="modal-overlay" onClick={dismissUpdatePrompt}>
      <div className="modal-card update-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{downloaded ? 'Update ready to install' : 'Update available'}</h2>
          <button className="modal-close" onClick={dismissUpdatePrompt}>
            ✕
          </button>
        </div>
        {mode === 'manual' ? (
          // macOS: say what is actually true on this platform instead of offering a download that
          // would be followed by an update that cannot be applied — which is how this used to end,
          // in an error, after the user had already said yes.
          <>
            <p className="modal-plot">
              Version {updateInfo.version} is available. This is the macOS build, which updates by hand:
              macOS will not let an unsigned app replace itself, so download the new version and swap
              the app over.
            </p>
            {notes && <pre className="update-notes">{notes}</pre>}
            <div className="pin-actions">
              <button type="button" className="secondary-button" onClick={dismissUpdatePrompt}>
                Later
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void window.api?.app?.openExternal?.(downloadPageUrl(updateInfo.version))}
              >
                Open download page
              </button>
            </div>
          </>
        ) : downloaded ? (
          <>
            <p className="modal-plot">
              Version {updateInfo.version} has been downloaded. Restart AllisonIPTV to finish installing it.
            </p>
            {notes && <pre className="update-notes">{notes}</pre>}
            <div className="pin-actions">
              <button type="button" className="secondary-button" onClick={dismissUpdatePrompt}>
                Later
              </button>
              <button type="button" className="primary-button" onClick={installUpdate}>
                Restart Now
              </button>
            </div>
          </>
        ) : downloading ? (
          <>
            <p className="modal-plot">Downloading version {updateInfo.version}…</p>
            <div className="update-progress-track">
              <div className="update-progress-fill" style={{ width: `${downloadPercent}%` }} />
            </div>
          </>
        ) : (
          <>
            <p className="modal-plot">Version {updateInfo.version} is available.</p>
            {notes && <pre className="update-notes">{notes}</pre>}
            {error && <div className="login-error">Update failed: {error}</div>}
            <div className="pin-actions">
              <button type="button" className="secondary-button" onClick={dismissUpdatePrompt}>
                Later
              </button>
              <button type="button" className="primary-button" onClick={() => void downloadUpdate()}>
                Update Now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
