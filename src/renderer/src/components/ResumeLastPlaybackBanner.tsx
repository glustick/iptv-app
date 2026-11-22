import { useAppStore } from '../store/useAppStore'

/**
 * The launch banner (0.41.0): "you were watching X when the app closed — resume?" Shown on
 * the Live TV tab until acted on, because that is the surface a returning viewer lands on.
 * Never auto-plays: the account may be single-connection, another device may be using the
 * slot, and an app that starts streaming uninvited is exactly the behaviour this app's
 * provider throttles. One click plays (through the store's own play(), so playlist-aware
 * routing, the recording-conflict rule and the previous-channel memory all apply unchanged);
 * dismissing clears the offer — the viewer said no.
 */
export function ResumeLastPlaybackBanner(): JSX.Element | null {
  const last = useAppStore((s) => s.settings.lastPlayback)
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const play = useAppStore((s) => s.play)
  const updateSettings = useAppStore((s) => s.updateSettings)

  if (!last || nowPlaying) return null

  return (
    <div className="resume-last-banner" role="status">
      <span>
        You were watching <strong>{last.name}</strong> when the app closed.
      </span>
      <button
        className="secondary-button"
        onClick={() =>
          play(last.kind, last.streamId, last.name, last.extension, last.icon, last.tvArchive, last.playlistId ?? undefined)
        }
      >
        Resume
      </button>
      <button className="secondary-button" onClick={() => updateSettings({ lastPlayback: null })}>
        Dismiss
      </button>
    </div>
  )
}
