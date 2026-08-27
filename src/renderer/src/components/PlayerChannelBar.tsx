import { useCallback, type CSSProperties } from 'react'
import { Grid } from 'react-window'
import { useAppStore } from '../store/useAppStore'
import { useElementSize } from '../lib/useElementSize'
import type { LiveStream, ShortEpgProgram } from '../lib/types'

const COLUMN_WIDTH = 180

interface CellProps {
  channels: LiveStream[]
  activeStreamId?: number
  shortEpgByStream: Record<number, ShortEpgProgram[]>
  onSelect: (channel: LiveStream) => void
}

function BarCell({
  columnIndex,
  style,
  channels,
  activeStreamId,
  shortEpgByStream,
  onSelect
}: { columnIndex: number; style: CSSProperties } & CellProps): JSX.Element | null {
  const channel = channels[columnIndex]
  if (!channel) return null
  const listings = shortEpgByStream[channel.stream_id]
  const now = Date.now()
  const current = listings?.find((p) => Number(p.start_timestamp) * 1000 <= now && now < Number(p.stop_timestamp) * 1000)
  // "Next" is whichever listing starts soonest after now — get_short_epg's results aren't
  // guaranteed sorted, so find the minimum rather than assuming the first future entry is it.
  const next = listings
    ?.filter((p) => Number(p.start_timestamp) * 1000 > now)
    .reduce<ShortEpgProgram | null>(
      (soonest, p) => (!soonest || Number(p.start_timestamp) < Number(soonest.start_timestamp) ? p : soonest),
      null
    )
  const elapsedPct = current
    ? Math.min(
        100,
        Math.max(
          0,
          ((now - Number(current.start_timestamp) * 1000) /
            (Number(current.stop_timestamp) * 1000 - Number(current.start_timestamp) * 1000)) *
            100
        )
      )
    : 0
  const active = activeStreamId === channel.stream_id

  return (
    <div style={style}>
      <button
        className={active ? 'channel-bar-item active' : 'channel-bar-item'}
        onClick={() => onSelect(channel)}
        title={channel.name}
      >
        <div className="channel-bar-head">
          {channel.stream_icon ? (
            <img src={channel.stream_icon} alt="" loading="lazy" />
          ) : (
            <span className="channel-bar-icon placeholder" />
          )}
          <span className="channel-bar-name">{channel.name}</span>
        </div>
        {current ? (
          <div className="channel-bar-listing">
            <span className="channel-bar-now">{current.title}</span>
            <div className="channel-bar-progress">
              <div className="channel-bar-progress-fill" style={{ width: `${elapsedPct}%` }} />
            </div>
            {next && <span className="channel-bar-next">Next: {next.title}</span>}
          </div>
        ) : (
          <div className="channel-bar-listing">
            <span className="channel-bar-now channel-bar-now--empty">No listing</span>
          </div>
        )}
      </button>
    </div>
  )
}

// The "channel bar": a small, semi-transparent strip of channels overlaid on the bottom of
// the fullscreen player, so you can flip to a different live channel without backing out to
// the full EPG grid. Toggled by clicking the video; reuses the same liveStreams/short-EPG
// cache the grid already populates, so channels already browsed there show their current
// programme here too.
export function PlayerChannelBar(): JSX.Element {
  const liveStreams = useAppStore((s) => s.liveStreams)
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const loadShortEpg = useAppStore((s) => s.loadShortEpg)
  const play = useAppStore((s) => s.play)
  const openChannelPreview = useAppStore((s) => s.openChannelPreview)

  const [containerRef, { width, height }] = useElementSize<HTMLDivElement>()

  const handleSelect = useCallback(
    (channel: LiveStream) => {
      play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon)
      // Keep the EPG grid's preview in sync so it shows this channel (highlighted,
      // ready to resume) rather than whatever was selected before you opened fullscreen.
      openChannelPreview(channel)
    },
    [play, openChannelPreview]
  )

  const onCellsRendered = useCallback(
    (visible: { columnStartIndex: number; columnStopIndex: number }) => {
      for (let i = visible.columnStartIndex; i <= visible.columnStopIndex; i++) {
        const channel = liveStreams[i]
        if (channel) loadShortEpg(channel.stream_id)
      }
    },
    [liveStreams, loadShortEpg]
  )

  return (
    <div className="player-channel-bar" ref={containerRef} onClick={(e) => e.stopPropagation()}>
      {width > 0 && height > 0 && liveStreams.length > 0 && (
        <Grid<CellProps>
          columnCount={liveStreams.length}
          columnWidth={COLUMN_WIDTH}
          rowCount={1}
          rowHeight={height}
          cellProps={{
            channels: liveStreams,
            activeStreamId: nowPlaying?.kind === 'live' ? nowPlaying.streamId : undefined,
            shortEpgByStream,
            onSelect: handleSelect
          }}
          onCellsRendered={onCellsRendered}
          style={{ width: '100%', height: '100%' }}
          cellComponent={BarCell}
        />
      )}
    </div>
  )
}
