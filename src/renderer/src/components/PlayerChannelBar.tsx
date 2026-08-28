import { useCallback, useMemo } from 'react'
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
  const favorites = useAppStore((s) => s.favorites)
  const clockFormat = useAppStore((s) => s.settings.clockFormat)
  const play = useAppStore((s) => s.play)
  const playTimeshift = useAppStore((s) => s.playTimeshift)
  const openChannelPreview = useAppStore((s) => s.openChannelPreview)

  // liveStreams reflects whatever category was last browsed in the main grid — if fullscreen
  // was entered some other way (e.g. picked from Favorites), the actual playing channel might
  // not be in it at all, and would be missing from its own swap bar. nowPlaying only carries
  // the flat fields play() was given, not a full LiveStream record, so a stand-in normally has
  // to fill the rest with the safest defaults (no catch-up, no category) — but if the channel
  // was reached via Favorites specifically, the full record (including tv_archive) is right
  // there in the favorites list, so check there first rather than guessing.
  const channels = useMemo(() => {
    if (nowPlaying?.kind !== 'live') return liveStreams
    if (liveStreams.some((c) => c.stream_id === nowPlaying.streamId)) return liveStreams
    const favorited = favorites.find((f): f is Extract<typeof f, { kind: 'live' }> => f.kind === 'live' && f.stream.stream_id === nowPlaying.streamId)
    const placeholder: LiveStream = favorited
      ? favorited.stream
      : {
          num: -1,
          name: nowPlaying.name,
          stream_type: 'live',
          stream_id: nowPlaying.streamId,
          stream_icon: '',
          epg_channel_id: null,
          added: '',
          category_id: '',
          custom_sid: null,
          tv_archive: 0,
          direct_source: '',
          tv_archive_duration: 0
        }
    return [placeholder, ...liveStreams]
  }, [liveStreams, nowPlaying, favorites])

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
        channels={channels}
        activeStreamId={nowPlaying?.kind === 'live' ? nowPlaying.streamId : undefined}
        clockFormat={clockFormat}
        rowHeight={ROW_HEIGHT}
        autoFocus
        onSelectChannel={handleSelect}
        onWatchFullscreen={handleSelect}
        onWatchTimeshift={handleTimeshift}
      />
    </div>
  )
}
