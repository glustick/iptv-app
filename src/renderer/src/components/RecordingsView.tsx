import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { RecordingEntry } from '../lib/types'

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatStartedAt(ms: number): string {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function statusChipClass(status: RecordingEntry['status']): string {
  return `recording-status recording-status--${status}`
}

/**
 * The Recordings tab (0.29.0): every entry in the main process's recordings.json index —
 * in-progress, scheduled, finished and partial alike — with Play / Reveal / Delete per entry.
 * The store's `recordings` slice is pushed by the main process on every change, so a recording
 * finishing mid-browse updates the row in place; refreshRecordings on mount covers the push
 * event racing the tab's first open.
 */
export function RecordingsView(): JSX.Element {
  const recordings = useAppStore((s) => s.recordings)
  const refreshRecordings = useAppStore((s) => s.refreshRecordings)
  const playRecording = useAppStore((s) => s.playRecording)
  const stopRecording = useAppStore((s) => s.stopRecording)
  const cancelScheduledRecording = useAppStore((s) => s.cancelScheduledRecording)
  const removeRecording = useAppStore((s) => s.removeRecording)
  const revealRecording = useAppStore((s) => s.revealRecording)

  useEffect(() => {
    void refreshRecordings()
  }, [refreshRecordings])

  if (recordings.length === 0) {
    return (
      <div className="recordings-view">
        <div className="history-header">
          <h3 className="section-heading">Recordings</h3>
        </div>
        <p className="empty-state">
          No recordings yet — use the ● button in the player header while watching live TV, or ⏺ on
          an upcoming programme in the guide to schedule one.
        </p>
      </div>
    )
  }

  return (
    <div className="recordings-view">
      <div className="history-header">
        <h3 className="section-heading">Recordings</h3>
      </div>
      <div className="recordings-list">
        {recordings.map((entry) => (
          <div key={entry.id} className="recordings-row">
            <div className="recordings-row-info">
              <span className="recordings-row-name">
                {entry.programmeTitle ?? entry.channelName}
                {entry.programmeTitle && <span className="recordings-row-channel"> · {entry.channelName}</span>}
              </span>
              <span className="recordings-row-meta">
                <span className={statusChipClass(entry.status)}>{entry.status}</span>
                <span>{formatStartedAt(entry.startedAt)}</span>
                <span>{formatBytes(entry.bytes)}</span>
              </span>
            </div>
            <div className="recordings-row-actions">
              {entry.status === 'recording' && (
                <button
                  className="history-refresh-button"
                  title="Stop this recording and finalise its playlist"
                  onClick={() => void stopRecording(entry.id)}
                >
                  Stop
                </button>
              )}
              {entry.status === 'scheduled' && (
                <button
                  className="history-clear-button"
                  title="Cancel this scheduled recording"
                  onClick={() => void cancelScheduledRecording(entry.id)}
                >
                  Cancel
                </button>
              )}
              {(entry.status === 'recording' || entry.status === 'done' || entry.status === 'partial') && (
                <button className="history-refresh-button" onClick={() => playRecording(entry)}>
                  Play
                </button>
              )}
              <button
                className="history-refresh-button"
                title="Show this recording's files in Finder"
                onClick={() => void revealRecording(entry.id)}
              >
                Reveal
              </button>
              <button
                className="history-clear-button"
                title="Move this recording to the trash"
                onClick={() => {
                  if (window.confirm(`Delete the recording of "${entry.programmeTitle ?? entry.channelName}"?`)) {
                    void removeRecording(entry.id)
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
