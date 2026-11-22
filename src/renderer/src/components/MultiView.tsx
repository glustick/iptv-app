import { useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useHlsAttach } from '../lib/useHlsAttach'
import { describeConnectionHolders } from '../lib/connectionLedger'
import { planConnectionRelease, releaseCandidates } from '../lib/connectionRelease'
import { MultiViewChannelPicker } from './MultiViewChannelPicker'
import type { LiveStream, MultiViewLayout } from '../lib/types'

const LAYOUTS: MultiViewLayout[] = [2, 4]

// Live TV only, watching several channels at once in a grid — each filled tile is a genuinely
// separate connection to the provider (its own hls.js instance via useHlsAttach, same as the
// small EPG preview panel elsewhere), not a shared one. That's exactly why singleConnectionAccount
// matters here in a way it doesn't for this app's other single-stream views: an account capped at
// one connection can only ever have one tile actually playing, so adding a second offers to stop
// this grid's own idlest silent tile ("Play here instead", 0.32.0) rather than being attempted
// blind and left to fail against the provider. This app's own real
// test account is single-connection, so genuinely simultaneous connections here were verified
// against synthetic local streams (a temporary M3U profile — max_connections is always '0' for
// those, so singleConnectionAccount never gates it — pointed at two independent local HLS
// streams), not this account directly: both tiles confirmed playing independently at once
// (currentTime advancing separately on each). That same live test also caught and fixed a real,
// pre-existing bug in proxyServer.ts's /__fetch/ route (see its own rewriteM3u8ForProxy comment)
// that would have affected any M3U provider's multi-segment channels, not just this feature.
export function MultiView(): JSX.Element {
  const layout = useAppStore((s) => s.settings.multiViewLayout)
  const slots = useAppStore((s) => s.multiViewSlots)
  const singleConnectionAccount = useAppStore((s) => s.singleConnectionAccount)
  const setMultiViewLayout = useAppStore((s) => s.setMultiViewLayout)
  const startPickingMultiViewSlot = useAppStore((s) => s.startPickingMultiViewSlot)
  const clearMultiViewSlot = useAppStore((s) => s.clearMultiViewSlot)
  const assignMultiViewChannel = useAppStore((s) => s.assignMultiViewChannel)
  const [activeAudioSlot, setActiveAudioSlot] = useState<number | null>(null)
  // 0.32.0 — what the last auto-release stopped, shown as a toolbar note with an Undo that is
  // only live while the freed slot is still empty (assigning something else there first is the
  // viewer's own statement; after that there is nothing to put back). Undo state lives here
  // rather than the store because the store's multiViewSlots deliberately outlive the tab
  // (switching away and back restores assignments) while an undo offer should not.
  const [releaseNote, setReleaseNote] = useState<string | null>(null)
  const [lastReleased, setLastReleased] = useState<{ slotIndex: number; channel: LiveStream } | null>(
    null
  )

  const filledCount = slots.filter(Boolean).length
  // Only relevant for an *empty* slot deciding whether "+ Add Channel" should work — a slot
  // that's already filled can always be removed (or swapped in place via ⇄) regardless of this,
  // and removing one frees up the account's one slot for a different tile immediately
  // (clearMultiViewSlot needs no gating of its own).
  const addBlocked = singleConnectionAccount && filledCount >= 1

  // The empty tile's way past the ceiling (0.32.0): stop this grid's idlest SILENT tile —
  // never the audible one, see lib/connectionRelease for the rule — then open the picker on
  // this tile so the freed connection is used for what the viewer actually wanted. If nothing
  // is honestly stoppable (the only filled tile is the audible one), the blocked tile falls
  // back to its sentence with no button.
  const playHereInstead = (slotIndex: number): void => {
    const plan = planConnectionRelease(releaseCandidates(slots, activeAudioSlot), addBlocked)
    if (!plan) return
    const victim = slots[plan.slotIndex]
    if (!victim) return
    clearMultiViewSlot(plan.slotIndex)
    setLastReleased({ slotIndex: plan.slotIndex, channel: victim })
    setReleaseNote(plan.note)
    startPickingMultiViewSlot(slotIndex)
  }

  const undoRelease = (): void => {
    if (!lastReleased) return
    if (slots[lastReleased.slotIndex] === null) {
      assignMultiViewChannel(lastReleased.slotIndex, lastReleased.channel)
    }
    setLastReleased(null)
    setReleaseNote(null)
  }

  return (
    <div className="multiview">
      <div className="multiview-toolbar">
        <span>Layout:</span>
        {LAYOUTS.map((n) => (
          <button
            key={n}
            className={n === layout ? 'multiview-layout-btn active' : 'multiview-layout-btn'}
            onClick={() => setMultiViewLayout(n)}
          >
            {n}
          </button>
        ))}
        {releaseNote && (
          <span className="multiview-release-note">
            {releaseNote}
            {lastReleased && slots[lastReleased.slotIndex] === null && (
              <button className="multiview-release-undo" onClick={undoRelease} title="Put the stopped tile back">
                Undo
              </button>
            )}
            <button
              className="multiview-release-dismiss"
              onClick={() => {
                setReleaseNote(null)
                setLastReleased(null)
              }}
              title="Dismiss"
            >
              ✕
            </button>
          </span>
        )}
      </div>
      <div className={`multiview-grid multiview-grid--${layout}`}>
        {slots.map((channel, i) => (
          <MultiViewTile
            key={i}
            slotIndex={i}
            channel={channel}
            addBlocked={addBlocked}
            canPlayHereInstead={addBlocked && planConnectionRelease(releaseCandidates(slots, activeAudioSlot), true) !== null}
            active={activeAudioSlot === i}
            onActivate={() => setActiveAudioSlot((s) => (s === i ? null : i))}
            onAdd={() => startPickingMultiViewSlot(i)}
            onSwap={() => startPickingMultiViewSlot(i)}
            onPlayHereInstead={() => playHereInstead(i)}
            onRemove={() => {
              clearMultiViewSlot(i)
              setActiveAudioSlot((s) => (s === i ? null : s))
            }}
          />
        ))}
      </div>
      <MultiViewChannelPicker />
    </div>
  )
}

function MultiViewTile({
  slotIndex,
  channel,
  addBlocked,
  canPlayHereInstead,
  active,
  onActivate,
  onAdd,
  onSwap,
  onPlayHereInstead,
  onRemove
}: {
  slotIndex: number
  channel: LiveStream | null
  addBlocked: boolean
  canPlayHereInstead: boolean
  active: boolean
  onActivate: () => void
  onAdd: () => void
  onSwap: () => void
  onPlayHereInstead: () => void
  onRemove: () => void
}): JSX.Element {
  const client = useAppStore((s) => s.client)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const url = channel && client ? client.getStreamUrl('live', channel.stream_id, 'm3u8') : null
  // Muted by default like every other tile — clicking one unmutes it and re-mutes whichever
  // other tile was previously active, so at most one plays audio at a time regardless of how
  // many tiles are actually filled.
  useHlsAttach(videoRef, url, !active, channel ? { id: `multiview-${slotIndex}`, label: `Screen ${slotIndex + 1} — ${channel.name}` } : undefined)

  if (!channel) {
    return (
      <div className="multiview-tile multiview-tile--empty">
        {addBlocked ? (
          <div className="multiview-tile-blocked">
            <p>
              This account only allows 1 connection at a time — another tile on this screen is using it.
            </p>
            <p className="multiview-tile-blocked-holders">Held by: {describeConnectionHolders()}</p>
            {/* Only offered when there is honestly something to stop: never the audible tile
                (lib/connectionRelease's rule), so the button disappears when the only filled
                tile is the one making sound. */}
            {canPlayHereInstead && (
              <button className="multiview-tile-add" onClick={onPlayHereInstead}>
                Play here instead
              </button>
            )}
          </div>
        ) : (
          <button className="multiview-tile-add" onClick={onAdd}>
            + Add Channel
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={active ? 'multiview-tile multiview-tile--active' : 'multiview-tile'} onClick={onActivate}>
      <video ref={videoRef} className="multiview-tile-video" autoPlay playsInline />
      <div className="multiview-tile-overlay">
        <span className="multiview-tile-name">{channel.name}</span>
        <span className="multiview-tile-mute-badge">{active ? '🔊' : '🔇'}</span>
        {/* 0.32.0 — change this tile's channel in place: reopening the picker for THIS slot
            replaces the channel without disturbing the tile's position, which tile is audible,
            or the layout. Assigning over a filled slot is exactly what the store action does
            (see assignMultiViewChannel) — until now there was simply no button that tried. */}
        <button
          className="multiview-tile-change"
          onClick={(e) => {
            e.stopPropagation()
            onSwap()
          }}
          title="Change this tile's channel"
        >
          ⇄
        </button>
        <button
          className="multiview-tile-remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="Remove from this screen"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
