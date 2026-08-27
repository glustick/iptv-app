import { useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { EpgGrid } from './EpgGrid'
import type { LiveStream, ShortEpgProgram } from '../lib/types'

const ROW_HEIGHT = 34

// The fullscreen channel-swap bar: the same Gantt-chart EPG grid used for browsing Live TV
// (channels down the vertical axis, time across the horizontal axis), just shrunk to a few
// rows and overlaid on the bottom of the video instead of taking the whole screen. Clicking a
// channel's name or anywhere on its programme timeline switches playback immediately — there's
// no separate "preview vs. watch" step here since the player is already fullscreen.
export function PlayerChannelBar(): JSX.Element {
  const liveStreams = useAppStore((s) => s.liveStreams)
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const clockFormat = useAppStore((s) => s.settings.clockFormat)
  const play = useAppStore((s) => s.play)
  const playTimeshift = useAppStore((s) => s.playTimeshift)
  const openChannelPreview = useAppStore((s) => s.openChannelPreview)

  const handleSelect = useCallback(
    (channel: LiveStream) => {
      play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon)
      // Keep the EPG grid's preview in sync so it shows this channel (highlighted,
      // ready to resume) rather than whatever was selected before you opened fullscreen.
      openChannelPreview(channel)
    },
    [play, openChannelPreview]
  )

  const handleTimeshift = useCallback(
    (channel: LiveStream, program: ShortEpgProgram) => {
      playTimeshift(channel, program)
    },
    [playTimeshift]
  )

  return (
    <div className="player-channel-bar" onClick={(e) => e.stopPropagation()}>
      <EpgGrid
        channels={liveStreams}
        activeStreamId={nowPlaying?.kind === 'live' ? nowPlaying.streamId : undefined}
        clockFormat={clockFormat}
        rowHeight={ROW_HEIGHT}
        onSelectChannel={handleSelect}
        onWatchFullscreen={handleSelect}
        onWatchTimeshift={handleTimeshift}
      />
    </div>
  )
}
