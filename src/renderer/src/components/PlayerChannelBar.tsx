import { useCallback, useMemo, useState } from 'react'
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

  // liveStreams reflects whatever category was last browsed in the main grid — if fullscreen
  // was entered some other way (e.g. picked from Favorites or Recently Watched), the actual
  // playing channel might not be in it at all, and would be missing from its own swap bar.
  // nowPlaying.tvArchive is carried through from whatever full LiveStream play() was actually
  // given (see the store), so the stand-in built here gets real catch-up availability instead
  // of always guessing "no catch-up".
  const channels = useMemo(() => {
    if (nowPlaying?.kind !== 'live') return liveStreams
    if (liveStreams.some((c) => c.stream_id === nowPlaying.streamId)) return liveStreams
    const placeholder: LiveStream = {
      num: -1,
      name: nowPlaying.name,
      stream_type: 'live',
      stream_id: nowPlaying.streamId,
      stream_icon: '',
      epg_channel_id: null,
      added: '',
      category_id: '',
      custom_sid: null,
      tv_archive: nowPlaying.tvArchive,
      direct_source: '',
      tv_archive_duration: 0
    }
    return [placeholder, ...liveStreams]
  }, [liveStreams, nowPlaying])

  // Scrolled to once, right when the bar opens, so the channel actually playing is immediately
  // visible instead of the list always starting at the top — a lazy useState initializer rather
  // than an effect specifically so it only ever runs this one time per mount (this component,
  // and the state along with it, is torn down and rebuilt fresh every time the bar closes and
  // reopens). Free-scrolling afterward during the same open is left alone: EpgGrid's own
  // appliedInitialScroll guard applies an initialScrollIndex exactly once, not on every render.
  const [initialScrollIndex] = useState(() => {
    const index = channels.findIndex((c) => nowPlaying?.kind === 'live' && c.stream_id === nowPlaying.streamId)
    return index >= 0 ? index : 0
  })

  const handleSelect = useCallback(
    (channel: LiveStream) => {
      play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon, channel.tv_archive)
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
        channels={channels}
        activeStreamId={nowPlaying?.kind === 'live' ? nowPlaying.streamId : undefined}
        clockFormat={clockFormat}
        rowHeight={ROW_HEIGHT}
        autoFocus
        initialScrollIndex={initialScrollIndex}
        onSelectChannel={handleSelect}
        onWatchFullscreen={handleSelect}
        onWatchTimeshift={handleTimeshift}
      />
    </div>
  )
}
