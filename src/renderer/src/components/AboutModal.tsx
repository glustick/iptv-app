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
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    if (!aboutOpen) return
    window.api.app.getInfo().then(setInfo)
  }, [aboutOpen])

  if (!aboutOpen) return null

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
        </div>
      </div>
    </div>
  )
}
