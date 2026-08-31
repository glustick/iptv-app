import { useAppStore } from '../store/useAppStore'

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

  // A downloaded update resurfaces regardless of an earlier "Later" on the plain available
  // prompt (see the store's onDownloaded, which resets updateDismissed itself) — from here,
  // dismissed is a plain, uniform toggle for whichever prompt is currently showing.
  if (!updateInfo || dismissed) return null

  const downloading = downloadPercent !== null

  return (
    <div className="modal-overlay" onClick={dismissUpdatePrompt}>
      <div className="modal-card update-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{downloaded ? 'Update ready to install' : 'Update available'}</h2>
          <button className="modal-close" onClick={dismissUpdatePrompt}>
            ✕
          </button>
        </div>
        {downloaded ? (
          <>
            <p className="modal-plot">
              Version {updateInfo.version} has been downloaded. Restart AllisonIPTV to finish installing it.
            </p>
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
