import { useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useHlsAttach } from '../lib/useHlsAttach'
import { MultiViewChannelPicker } from './MultiViewChannelPicker'
import type { LiveStream, MultiViewLayout } from '../lib/types'

const LAYOUTS: MultiViewLayout[] = [2, 4]

// Live TV only, watching several channels at once in a grid — each filled tile is a genuinely
// separate connection to the provider (its own hls.js instance via useHlsAttach, same as the
// small EPG preview panel elsewhere), not a shared one. That's exactly why singleConnectionAccount
// matters here in a way it doesn't for this app's other single-stream views: an account capped at
// one connection can only ever have one tile actually playing, so adding a second is refused with
// an explanation rather than attempted and left to fail against the provider. This app's own real
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
  const [activeAudioSlot, setActiveAudioSlot] = useState<number | null>(null)

  const filledCount = slots.filter(Boolean).length
  // Only relevant for an *empty* slot deciding whether "+ Add Channel" should work — a slot
  // that's already filled can always be removed regardless of this, and removing one frees up
  // the account's one slot for a different tile immediately (clearMultiViewSlot needs no gating
  // of its own).
  const addBlocked = singleConnectionAccount && filledCount >= 1

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
      </div>
      <div className={`multiview-grid multiview-grid--${layout}`}>
        {slots.map((channel, i) => (
          <MultiViewTile
            key={i}
            channel={channel}
            addBlocked={addBlocked}
            active={activeAudioSlot === i}
            onActivate={() => setActiveAudioSlot((s) => (s === i ? null : i))}
            onAdd={() => startPickingMultiViewSlot(i)}
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
  channel,
  addBlocked,
  active,
  onActivate,
  onAdd,
  onRemove
}: {
  channel: LiveStream | null
  addBlocked: boolean
  active: boolean
  onActivate: () => void
  onAdd: () => void
  onRemove: () => void
}): JSX.Element {
  const client = useAppStore((s) => s.client)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const url = channel && client ? client.getStreamUrl('live', channel.stream_id, 'm3u8') : null
  // Muted by default like every other tile — clicking one unmutes it and re-mutes whichever
  // other tile was previously active, so at most one plays audio at a time regardless of how
  // many tiles are actually filled.
  useHlsAttach(videoRef, url, !active)

  if (!channel) {
    return (
      <div className="multiview-tile multiview-tile--empty">
        {addBlocked ? (
          <p className="multiview-tile-blocked">
            This account only allows 1 connection at a time — remove a channel from another screen first.
          </p>
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
