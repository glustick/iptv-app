import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { useAppStore } from '../store/useAppStore'
import { PlayerChannelBar } from './PlayerChannelBar'
import { PlayerStatsOverlay } from './PlayerStatsOverlay'
import { PlayerSeekBar } from './PlayerSeekBar'
import { VpnWarnings } from './VpnWarnings'
import { useTranscodeFallback } from '../lib/useTranscodeFallback'

const MAX_NETWORK_RETRIES = 4
const MAX_MEDIA_ERROR_RECOVERIES = 3
const MEDIA_ERROR_RESET_AFTER_MS = 15000
const PROGRESS_SAVE_INTERVAL_MS = 5000
const CHANNEL_BAR_AUTO_HIDE_MS = 6000
const SKIP_SECONDS = 10
const SKIP_SECONDS_LONG = 60
// How often (and for how long) to poll for the "video decoding, audio never has" symptom — see
// the detection code in the main playback effect for why this is a poll rather than one check.
// The attempt budget has to cover how long a title takes to even START decoding, not just how
// long detection itself needs — confirmed with a real ~10GB movie file that took ~20s of
// initial buffering before video decoding began at all (a smaller live-TV segment starts in a
// couple of seconds), which alone would exhaust a 20-attempt/20s budget before the 2-consecutive-
// silent-tick check ever got a chance to run.
const SILENT_AUDIO_CHECK_INTERVAL_MS = 1000
const SILENT_AUDIO_MAX_CHECK_ATTEMPTS = 90
// Some Xtream accounts cap concurrent connections at exactly 1 (confirmed against the real test
// account via get_server_info — max_connections: "1") — pausing/detaching the original <video>
// stops the browser from requesting more of it, but doesn't guarantee the origin server has
// actually recognized that connection as closed by the time ffmpeg tries to open a new one.
// Racing that gap produced a real net::ERR_HTTP2_PROTOCOL_ERROR and, worse, a transcode request
// that hung indefinitely with zero output on this exact account. This delay gives the origin a
// moment to actually release the slot first. Bumped from 2s to 8s after reproducing that exact
// "hung indefinitely, zero output" failure live again on a real single-connection account's VOD
// title — 2s evidently isn't always enough for this provider's origin to notice the old
// connection is gone before ffmpeg tries to open a new one to the same account.
const CONNECTION_RELEASE_DELAY_MS = 8000

// webkitVideoDecodedByteCount/webkitAudioDecodedByteCount are real, long-standing Chromium
// extensions, not in the standard DOM lib types — same ones PlayerStatsOverlay.tsx already
// relies on to display live decode stats, reused here to detect the failure automatically
// instead of just reporting it after the fact.
interface ChromiumVideoElement extends HTMLVideoElement {
  webkitVideoDecodedByteCount?: number
  webkitAudioDecodedByteCount?: number
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
// Real observed probe times against a single-connection test account (0.6.3) ranged 25-90s just
// to open the source, before ffmpeg writes a frame — well within that range isn't yet unusual.
// 60s sits past the common case but still comfortably inside the 240s deadline, so this fires
// while there's genuinely still time left for the account-cap explanation to be useful, rather
// than only once the wait is already effectively over.
const SINGLE_CONNECTION_HINT_AFTER_SECONDS = 60
// Click-zone threshold for the fullscreen EPG channel bar, in pixels from the bottom screen
// edge — roughly matched to the channel bar's own height (see CHANNEL_BAR height in global.css)
// so the zone lines up with the chrome it reveals rather than an arbitrary split. Deliberately
// independent from SEEKBAR_REVEAL_ZONE_FRACTION just below, even though both sit near the
// bottom edge: this one is click-triggered and fullscreen-only, while the seek bar's is
// hover-triggered and applies in windowed mode too — a fixed pixel count wouldn't scale
// sensibly there. They don't currently conflict (a click still reaches the video first; the
// seek bar only intercepts a much thinner strip right at its own edge), but if either threshold
// changes, sanity-check the other still makes sense next to it.
const BOTTOM_ZONE_PX = 220
// The seek bar itself reveals on hover/cursor position (not click) — a fraction of the player's
// own height rather than a fixed pixel count so it scales sensibly whether the player is
// windowed or truly fullscreen.
const SEEKBAR_REVEAL_ZONE_FRACTION = 0.2
// The header reveals purely on cursor position, in both windowed and fullscreen mode and for
// every content kind — cursor in the top 10% of the player shows it, moving away hides it again,
// no click needed. A fraction of the player's own height (not a fixed pixel count) so it tracks
// "top 10% of the player" regardless of window size.
const HEADER_REVEAL_ZONE_FRACTION = 0.1

export function Player(): JSX.Element | null {
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const stop = useAppStore((s) => s.stop)
  const bufferProfile = useAppStore((s) => s.settings.bufferProfile)
  const persistedVolume = useAppStore((s) => s.settings.playerVolume)
  const persistedMuted = useAppStore((s) => s.settings.playerMuted)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const episodeProgress = useAppStore((s) => s.episodeProgress)
  const updateEpisodeProgress = useAppStore((s) => s.updateEpisodeProgress)
  const isOnline = useAppStore((s) => s.isOnline)
  const showChannelBar = useAppStore((s) => s.channelBarOpen)
  const setShowChannelBar = useAppStore((s) => s.setChannelBarOpen)
  const vpnHasProfiles = useAppStore((s) => s.settings.vpnProfiles.length > 0)
  const vpnStatus = useAppStore((s) => s.vpnStatus)
  const toggleVpnTunnel = useAppStore((s) => s.toggleVpnTunnel)
  const singleConnectionAccount = useAppStore((s) => s.singleConnectionAccount)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const playerRef = useRef<HTMLDivElement | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [buffering, setBuffering] = useState(false)
  const [pipActive, setPipActive] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [headerVisible, setHeaderVisible] = useState(true)
  const [statsVisible, setStatsVisible] = useState(false)
  const [cursorNearBottom, setCursorNearBottom] = useState(false)
  // hls.js's own, free/instant notion of "which renditions does the CURRENT source's playlist
  // carry" — populated from Hls.Events.SUBTITLE_TRACKS_UPDATED, which fires for *any* m3u8 with
  // #EXT-X-MEDIA:TYPE=SUBTITLES entries, live or not: a genuinely multi-language live channel's
  // own master playlist works exactly the same way here as the transcode fallback's own
  // (VOD/series-only, always exactly one track) generated one does — hls.js doesn't distinguish
  // the two. (See subtitleTracks/switchSubtitleTrack below for the separate, ffmpeg-level notion
  // of "which language could this be transcoded with" — that one restarts the whole transcode to
  // switch; this one is just picking among renditions the current source already offers.)
  const [hlsSubtitleTracks, setHlsSubtitleTracks] = useState<{ id: number; name: string }[]>([])
  const [activeHlsSubtitleTrack, setActiveHlsSubtitleTrack] = useState(-1)
  // Same idea as hlsSubtitleTracks above, but for #EXT-X-MEDIA:TYPE=AUDIO — unlike subtitles
  // there's no "off" state (a source with alternate audio renditions still always has exactly
  // one active), so this only ever needs a track to cycle through, never an on/off toggle.
  const [hlsAudioTracks, setHlsAudioTracks] = useState<{ id: number; name: string }[]>([])
  const [activeHlsAudioTrack, setActiveHlsAudioTrack] = useState(-1)
  const wasOffline = useRef(false)
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastStreamKeyRef = useRef<string | null>(null)
  const [transcodeElapsedSeconds, setTranscodeElapsedSeconds] = useState(0)

  const {
    transcoding,
    getSourceUrl,
    tryFallback,
    tryFallbackForSilentAudio,
    reset: resetTranscodeFallback,
    beginRun: beginTranscodeRun,
    subtitleTracks,
    activeSubtitleTrackIndex,
    switchSubtitleTrack
  } = useTranscodeFallback()

  // Channel identity changing (including to nothing, i.e. the player closing) is the only
  // thing that should reset the transcode-fallback state or tear down a session — a fresh
  // hls reload of the SAME channel (network reconnect, the fallback's own reload) must not.
  // Deliberately its own effect, decoupled from the main playback effect's other triggers
  // (bufferProfile, reloadTick), so those don't also reset this.
  useEffect(() => {
    const streamKey = nowPlaying ? `${nowPlaying.kind}:${nowPlaying.streamId}` : null
    if (streamKey === lastStreamKeyRef.current) return
    lastStreamKeyRef.current = streamKey
    resetTranscodeFallback()
  }, [nowPlaying, resetTranscodeFallback])

  // Auto-reconnect: if the whole network dropped (not just this fragment), hls.js's own
  // retry budget may already be exhausted by the time connectivity returns. Force a fresh
  // attach once we're back online rather than leaving a dead player up.
  useEffect(() => {
    if (!isOnline) {
      wasOffline.current = true
    } else if (wasOffline.current) {
      wasOffline.current = false
      if (nowPlaying) setReloadTick((t) => t + 1)
    }
  }, [isOnline, nowPlaying])

  // The audio-fix wait for movies/series has no real progress to report — ffmpeg either hasn't
  // opened the source yet or is still probing it — so the only honest signal available is how
  // long it's been running. Surfacing that (see the "Fixing audio…" message below) is what
  // actually answers "is this stuck?" for a wait that can genuinely take a couple of minutes on
  // this account's slower titles, rather than leaving a static spinner that looks identical
  // whether it's 5 seconds in or hung entirely.
  useEffect(() => {
    if (!transcoding) {
      setTranscodeElapsedSeconds(0)
      return
    }
    const interval = setInterval(() => setTranscodeElapsedSeconds((s) => s + 1), 1000)
    return () => clearInterval(interval)
  }, [transcoding])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !nowPlaying) return

    // A fresh <video> element (the player was just opened, or reopened after being fully
    // closed) always starts at the browser's own defaults (volume 1, unmuted) — reapplying the
    // last-used values here on every run of this effect is safe even for an internal reload of
    // the same channel (network reconnect, transcode fallback) or a channel switch, since
    // persistedVolume/persistedMuted already reflect whatever the user last set in real time
    // (see the volumechange-driven updateSettings call below).
    video.volume = persistedVolume
    video.muted = persistedMuted

    setPlaybackError(null)
    setBuffering(true)
    setHlsSubtitleTracks([])
    setActiveHlsSubtitleTrack(-1)
    setHlsAudioTracks([])
    setActiveHlsAudioTrack(-1)
    beginTranscodeRun()
    let networkRetryCount = 0
    let mediaErrorRecoveryCount = 0
    let mediaErrorResetTimer: ReturnType<typeof setTimeout> | null = null
    let progressInterval: ReturnType<typeof setInterval> | null = null
    let silentAudioCheckTimer: ReturnType<typeof setInterval> | null = null

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const handleWaiting = (): void => {
      setBuffering(true)
      // Still recovering — don't let a stretch of genuinely uninterrupted playback earlier
      // in the session forgive a media error that's actively recurring right now.
      if (mediaErrorResetTimer) {
        clearTimeout(mediaErrorResetTimer)
        mediaErrorResetTimer = null
      }
    }
    const handlePlaying = (): void => {
      setBuffering(false)
      // A stretch of real, uninterrupted playback means whatever caused an earlier media
      // error is very likely no longer happening — reset the recovery count so a later,
      // unrelated blip gets its own full set of attempts instead of inheriting exhausted
      // ones from a problem that already resolved itself.
      if (mediaErrorResetTimer) clearTimeout(mediaErrorResetTimer)
      mediaErrorResetTimer = setTimeout(() => {
        mediaErrorRecoveryCount = 0
      }, MEDIA_ERROR_RESET_AFTER_MS)
    }
    const handleCanPlay = (): void => setBuffering(false)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('playing', handlePlaying)
    video.addEventListener('canplay', handleCanPlay)

    // Resume series episodes where you left off.
    if (nowPlaying.kind === 'series') {
      const saved = episodeProgress[nowPlaying.streamId]
      if (saved && saved.durationSeconds > 0 && saved.positionSeconds < saved.durationSeconds * 0.95) {
        const resumeAt = saved.positionSeconds
        const onLoadedMetadata = (): void => {
          video.currentTime = resumeAt
        }
        video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })
      }
      progressInterval = setInterval(() => {
        if (video.duration > 0 && !Number.isNaN(video.duration)) {
          updateEpisodeProgress(String(nowPlaying.streamId), video.currentTime, video.duration)
        }
      }, PROGRESS_SAVE_INTERVAL_MS)
    }

    // Falls back to the ffmpeg-transcoded output for this exact channel once one exists —
    // set by the ERROR handler below the first time it detects an unsupported audio codec.
    const sourceUrl = getSourceUrl(nowPlaying.url)
    const isM3u8 = sourceUrl.endsWith('.m3u8')

    if (isM3u8 && Hls.isSupported()) {
      const smooth = bufferProfile === 'smooth'
      // hls.js only knows a playlist is genuinely finished once it sees #EXT-X-ENDLIST — until
      // then, it treats it as "live" regardless of *why* the tag is absent. The audio-fix
      // transcode's own output (movies/series, never real Live TV) has no ENDLIST for as long
      // as ffmpeg is still working through the source, which for a slow connection can be most
      // or all of a viewing session — so without this check, this hls.js instance would apply
      // real Live TV's "jump forward if you fall behind the live edge" logic to a movie, using
      // ffmpeg's own transcode progress as the "live edge". Confirmed live: since ffmpeg often
      // encodes at 19-50x realtime (-c:v copy is barely CPU-bound), a normal 1x viewer falls
      // behind that "edge" by more than the live-latency threshold within under a minute,
      // triggering repeated forced seeks forward with no user input — exactly the "video skips
      // ahead" symptom reported live. Real Live TV still wants the live-edge behavior (that's
      // what "Live" TV is), so this only disables it for the fallback's own on-demand content.
      const isLiveContent = nowPlaying.kind === 'live'
      const hls = new Hls({
        enableWorker: true,
        // "Smooth" favors stutter-free playback over sitting right on the live edge: a
        // generous buffer absorbs brief network hiccups at the cost of a few seconds of
        // extra latency. "Low latency" trades that back for staying closer to real-time.
        maxBufferLength: smooth ? 60 : 20,
        maxMaxBufferLength: smooth ? 120 : 40,
        backBufferLength: smooth ? 90 : 30,
        // hls.js requires liveMaxLatencyDurationCount to be strictly greater than
        // liveSyncDurationCount (it throws synchronously from the constructor otherwise) — so
        // the non-live "effectively infinite" values below must differ, not just both be huge.
        liveSyncDurationCount: isLiveContent ? (smooth ? 5 : 3) : 1_000_000,
        liveMaxLatencyDurationCount: isLiveContent ? (smooth ? 10 : 6) : 2_000_000,
        fragLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 6
      })
      hlsRef.current = hls
      hls.loadSource(sourceUrl)
      hls.attachMedia(video)
      // Fires once hls.js has parsed the (master or flat) playlist and knows what subtitle
      // renditions, if any, it references — a genuinely multi-language live channel's own master
      // playlist populates this the same way the transcode fallback's single-track one does.
      // Defaults to whatever hls.js auto-selected (a master playlist's own DEFAULT=YES), which is
      // why subtitles can already show up with no explicit code enabling them.
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
        setHlsSubtitleTracks(data.subtitleTracks.map((t) => ({ id: t.id, name: t.name || t.lang?.toUpperCase() || `Track ${t.id + 1}` })))
      })
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_event, data) => {
        setActiveHlsSubtitleTrack(data.id)
      })
      // Same shape as subtitles above, for #EXT-X-MEDIA:TYPE=AUDIO — confirmed live on real
      // multi-language channels this provider serves (0.6.1's "single flat rendition per
      // channel" finding held for the 4 channels sampled then, but evidently not universally).
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
        setHlsAudioTracks(data.audioTracks.map((t) => ({ id: t.id, name: t.name || t.lang?.toUpperCase() || `Track ${t.id + 1}` })))
      })
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
        setActiveHlsAudioTrack(data.id)
      })
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Try transcoding once for the EC-3/AC-3-shaped failure (see useTranscodeFallback)
        // before falling through to either path's normal (terminal) error handling — and
        // ignore repeats of it while a fix is already in flight, since ffmpeg takes a few
        // real seconds to spin up and this same still-broken hls instance keeps hitting the
        // identical error meanwhile.
        if (
          tryFallback(
            data,
            nowPlaying.url,
            () => setReloadTick((t) => t + 1),
            (message) => setPlaybackError(`Audio codec not supported by this player, and automatic transcoding failed: ${message}`)
          )
        ) {
          setPlaybackError(null)
          return
        }

        if (!data.fatal) {
          // A codec/append error scoped to a single SourceBuffer (very often the audio
          // track — e.g. an AC-3/E-AC-3 feed, which Chromium has no decoder for) can
          // silently kill just that track while video keeps playing fine, with nothing
          // else ever surfacing the problem. Call it out explicitly instead.
          if (data.details === 'bufferAddCodecError' || data.details === 'bufferAppendError') {
            const isAudio = typeof data.mimeType === 'string' && data.mimeType.toLowerCase().includes('audio')
            setPlaybackError(
              `${isAudio ? 'Audio' : 'Video'} codec not supported by this player. This channel's ${isAudio ? 'audio' : 'video'} stream isn't compatible with this app's playback engine${isAudio ? ' (commonly AC-3/E-AC-3 audio, which this app cannot decode)' : ''}.`
            )
          }
          return
        }
        console.error(
          '[player] fatal hls error',
          JSON.stringify({
            type: data.type,
            details: data.details,
            reason: data.reason,
            err: data.error?.message,
            levelIndex: data.level,
            frag: data.frag ? { sn: data.frag.sn, url: data.frag.url, level: data.frag.level } : undefined
          })
        )
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            networkRetryCount += 1
            if (networkRetryCount <= MAX_NETWORK_RETRIES) {
              hls.startLoad()
            } else {
              setPlaybackError(`Playback error: ${data.details} (gave up after ${MAX_NETWORK_RETRIES} retries)`)
              hls.destroy()
            }
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            // recoverMediaError() alone has no retry cap, so a persistent (non-transient)
            // media error — some channels hit one consistently, not just as a rare blip —
            // recovers, immediately re-fails, and recovers again in a tight loop: every
            // cycle briefly resets and re-seeks the video, which is what actually produces
            // the visible flicker, not the buffering itself. Escalate instead of looping
            // forever, matching hls.js's own recommended recovery pattern.
            mediaErrorRecoveryCount += 1
            if (mediaErrorRecoveryCount > MAX_MEDIA_ERROR_RECOVERIES) {
              setPlaybackError(
                `Playback error: ${data.details} (gave up after ${MAX_MEDIA_ERROR_RECOVERIES} recovery attempts)`
              )
              hls.destroy()
            } else if (mediaErrorRecoveryCount === 2) {
              hls.swapAudioCodec()
              hls.recoverMediaError()
            } else {
              hls.recoverMediaError()
            }
            break
          default:
            setPlaybackError(`Playback error: ${data.details}`)
            hls.destroy()
        }
      })
      video.play().catch(() => {})
    } else {
      video.src = nowPlaying.url
      video.play().catch(() => {})

      // VOD/series have no hls.js instance and therefore no ERROR event — an unsupported
      // (typically AC-3/E-AC-3) audio track doesn't fail visibly here the way it does for live
      // TV: Chromium just decodes the video track fine and silently produces no sound at all,
      // with nothing on video.error or in the console to say so. Polling is the only way to
      // catch it. A single fixed-delay check turned out to be fragile in practice — how long a
      // title takes to actually start decoding varies (network conditions, file size), and a
      // check that lands before video decoding has even begun looks identical to a genuinely
      // silent title and never gets a second chance. Polling instead: wait for video to
      // definitely be decoding, then require two consecutive ticks of "video yes, audio no"
      // before concluding it's the codec failure rather than a brief startup race.
      //
      // A second, distinct failure shape shares this same detection loop, added defensively —
      // NOT yet confirmed live the way the silent-audio case below was (an initial live
      // reproduction attempt on a real .mkv title looked like this at first with a short
      // sampling window, but a longer one showed video *did* briefly start decoding, meaning
      // that specific title actually hit the ordinary silent-audio path below, not this one).
      // Still worth having: if a title's video genuinely never decodes at all (Chromium's
      // <video> element has no demuxer for some container/codec entirely, as opposed to a
      // supported container with one specifically unsupported track), the *original* logic
      // here only ever counted consecutive "video yes, audio no" ticks, which that case would
      // never satisfy (video permanently 0) — it would poll for the full
      // SILENT_AUDIO_MAX_CHECK_ATTEMPTS budget and then give up *silently*, leaving the player
      // stuck on an endless buffering spinner forever with no error and no fallback ever
      // attempted. The same ffmpeg remux this path already runs for silent-audio titles would
      // fix that too, since it produces a fresh HLS output regardless of the source container —
      // the gap was ever detecting the case instead of quietly giving up on it.
      let consecutiveSilentAudioTicks = 0
      let silentAudioCheckAttempts = 0
      let everDecodedVideo = false
      silentAudioCheckTimer = setInterval(() => {
        silentAudioCheckAttempts += 1
        const chromiumVideo = video as ChromiumVideoElement
        const videoBytes = chromiumVideo.webkitVideoDecodedByteCount ?? 0
        const audioBytes = chromiumVideo.webkitAudioDecodedByteCount ?? 0
        if (videoBytes > 0) everDecodedVideo = true
        consecutiveSilentAudioTicks = videoBytes > 0 && audioBytes === 0 ? consecutiveSilentAudioTicks + 1 : 0

        const confirmedSilentAudio = consecutiveSilentAudioTicks >= 2
        const timedOut = silentAudioCheckAttempts >= SILENT_AUDIO_MAX_CHECK_ATTEMPTS
        // Nothing ever decoded despite the full timeout window this account's slower titles
        // already need (see startTranscode's own 25-90s observed input-open times) — treated
        // as "unplayable format," not "still starting up."
        const confirmedUnplayableFormat = timedOut && !everDecodedVideo

        if (!confirmedSilentAudio && !timedOut) return
        if (silentAudioCheckTimer) clearInterval(silentAudioCheckTimer)
        silentAudioCheckTimer = null
        if (!confirmedSilentAudio && !confirmedUnplayableFormat) return

        // Unlike live TV (where the hls.js source triggering tryFallback is already broken and
        // has mostly stopped pulling data by the time it fires), this video is otherwise
        // healthy — either playing fine with no sound, or still pulling real bytes over the
        // network despite never decoding any of them — so left alone it keeps aggressively
        // buffering ahead from the original URL for the entire time ffmpeg is also reading
        // that same URL through the same local proxy. Two concurrent requests for the same
        // resource that way was enough to trip a real net::ERR_HTTP2_PROTOCOL_ERROR against
        // this provider — pausing and detaching the source first, before asking for the
        // transcode, avoids the contention instead of hoping the origin tolerates it. See
        // CONNECTION_RELEASE_DELAY_MS for why starting the transcode itself is also delayed,
        // not just the detach.
        video.pause()
        video.removeAttribute('src')
        video.load()

        silentAudioCheckTimer = setTimeout(() => {
          silentAudioCheckTimer = null
          tryFallbackForSilentAudio(
            nowPlaying.url,
            () => setReloadTick((t) => t + 1),
            (message) =>
              setPlaybackError(
                `${confirmedUnplayableFormat ? "This title's format isn't supported by this player" : 'Audio codec not supported by this player'}, and automatic transcoding failed: ${message}` +
                  (singleConnectionAccount
                    ? ' (this account only allows one connection at a time, which can cause exactly this)'
                    : '')
              )
          )
        }, CONNECTION_RELEASE_DELAY_MS)
      }, SILENT_AUDIO_CHECK_INTERVAL_MS)
    }

    return () => {
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('canplay', handleCanPlay)
      if (mediaErrorResetTimer) clearTimeout(mediaErrorResetTimer)
      if (progressInterval) clearInterval(progressInterval)
      if (silentAudioCheckTimer) clearInterval(silentAudioCheckTimer)
      if (nowPlaying.kind === 'series' && video.duration > 0 && !Number.isNaN(video.duration)) {
        updateEpisodeProgress(String(nowPlaying.streamId), video.currentTime, video.duration)
      }
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [nowPlaying, bufferProfile, reloadTick])

  // The channel bar auto-hides after a few seconds of inactivity, like a real set-top
  // box's channel banner. Re-armed whenever it's shown or a channel is picked from it.
  useEffect(() => {
    if (autoHideTimer.current) clearTimeout(autoHideTimer.current)
    if (!showChannelBar) return
    autoHideTimer.current = setTimeout(() => setShowChannelBar(false), CHANNEL_BAR_AUTO_HIDE_MS)
    return () => {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current)
    }
  }, [showChannelBar, nowPlaying])

  // The channel bar only makes sense for live TV — hide it if playback switches to
  // something else (e.g. a series episode played from elsewhere while it was open).
  useEffect(() => {
    if (nowPlaying?.kind !== 'live') setShowChannelBar(false)
  }, [nowPlaying])

  // Keyboard shortcuts while the player is open: M to mute, arrows for volume, and (live only,
  // matching the header's transport buttons — VOD/series already get Space/arrow-seek for free
  // from the native <video controls>) Space for play/pause, left/right arrows to skip (shift
  // for the 60s jump — the common "small step / big step" convention), and End to jump to live.
  // Escape is deliberately not handled here — see App.tsx's single centralized Escape handler,
  // which already covers closing the channel bar and the player itself in the right order.
  useEffect(() => {
    if (!nowPlaying) return
    const kind = nowPlaying.kind
    function onKeyDown(e: KeyboardEvent): void {
      const video = videoRef.current
      if (!video) return
      if (e.key === 'm' || e.key === 'M') {
        video.muted = !video.muted
      } else if (e.key === 'ArrowUp') {
        video.volume = Math.min(1, video.volume + 0.05)
        e.preventDefault()
      } else if (e.key === 'ArrowDown') {
        video.volume = Math.max(0, video.volume - 0.05)
        e.preventDefault()
      } else if (kind === 'live' && e.key === ' ') {
        e.preventDefault()
        togglePlayPause()
      } else if (kind === 'live' && e.key === 'ArrowLeft') {
        e.preventDefault()
        skip(e.shiftKey ? -SKIP_SECONDS_LONG : -SKIP_SECONDS)
      } else if (kind === 'live' && e.key === 'ArrowRight') {
        e.preventDefault()
        skip(e.shiftKey ? SKIP_SECONDS_LONG : SKIP_SECONDS)
      } else if (kind === 'live' && e.key === 'End') {
        e.preventDefault()
        goToLive()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [nowPlaying])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onEnterPip = (): void => setPipActive(true)
    const onLeavePip = (): void => setPipActive(false)
    video.addEventListener('enterpictureinpicture', onEnterPip)
    video.addEventListener('leavepictureinpicture', onLeavePip)
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnterPip)
      video.removeEventListener('leavepictureinpicture', onLeavePip)
    }
  }, [nowPlaying])

  // Keeps the header's play/pause and volume controls in sync regardless of what actually
  // changed them — the video element's own state (a native-control click for VOD/series, the
  // M/arrow-key shortcuts, or these new buttons) rather than assuming this UI is the only
  // mutator of paused/muted/volume.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const syncPlayState = (): void => setPaused(video.paused)
    const syncVolumeState = (): void => {
      setMuted(video.muted)
      setVolume(video.volume)
      // Persisted regardless of what changed it (slider, mute button, M key, or a native VOD
      // control) so the next time the player opens — this channel, a different one, or after a
      // full app restart — it picks up wherever the user last left the volume.
      updateSettings({ playerVolume: video.volume, playerMuted: video.muted })
    }
    syncPlayState()
    syncVolumeState()
    video.addEventListener('play', syncPlayState)
    video.addEventListener('pause', syncPlayState)
    video.addEventListener('volumechange', syncVolumeState)
    return () => {
      video.removeEventListener('play', syncPlayState)
      video.removeEventListener('pause', syncPlayState)
      video.removeEventListener('volumechange', syncVolumeState)
    }
  }, [nowPlaying, updateSettings])

  // document.fullscreenElement (not a per-window Electron API) is what actually toggles here —
  // requestFullscreen() targets this player's own container, not the OS window, so the app's
  // title bar/other windows are untouched; only this element grows to fill the screen.
  useEffect(() => {
    const onFullscreenChange = (): void => setIsFullscreen(document.fullscreenElement === playerRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  // The header starts visible every time a new title starts playing (or the player reopens) —
  // a normal "here are the controls" moment on load — and from then on is purely cursor-driven
  // (see the mousemove effect below), in both windowed and fullscreen mode alike.
  useEffect(() => {
    setHeaderVisible(true)
  }, [nowPlaying])

  // The seek bar (unlike the header/channel bar, which are click-toggled) reveals purely on
  // cursor position — it's meant to be glanceable without an extra click, but shouldn't sit
  // permanently over the picture either. Booleans bail out of re-rendering when the new value
  // matches the current one, so this is cheap even at native mousemove frequency.
  useEffect(() => {
    const container = playerRef.current
    if (!container || nowPlaying?.kind !== 'live') return
    function onMouseMove(e: MouseEvent): void {
      const rect = container!.getBoundingClientRect()
      setCursorNearBottom(e.clientY > rect.top + rect.height * (1 - SEEKBAR_REVEAL_ZONE_FRACTION))
    }
    container.addEventListener('mousemove', onMouseMove)
    return () => container.removeEventListener('mousemove', onMouseMove)
  }, [nowPlaying])

  // The header: purely hover-driven, in both windowed and fullscreen mode and for every content
  // kind — cursor in the top 10% of the player reveals it, moving away instantly hides it again,
  // no click needed. The player overlay is always a fixed, full-viewport layer (see
  // .player-overlay in global.css) regardless of the Fullscreen API's own on/off state, so this
  // works identically either way.
  useEffect(() => {
    const container = playerRef.current
    if (!container) return
    function onMouseMove(e: MouseEvent): void {
      const rect = container!.getBoundingClientRect()
      setHeaderVisible(e.clientY < rect.top + rect.height * HEADER_REVEAL_ZONE_FRACTION)
    }
    container.addEventListener('mousemove', onMouseMove)
    return () => container.removeEventListener('mousemove', onMouseMove)
  }, [nowPlaying])

  // Picture-in-Picture opens a genuine floating OS window (confirmed: it renders on top of
  // other apps, not just inside this one) tied to this video element — closing the player or
  // switching channels while it's open would otherwise leave that window floating on the
  // desktop indefinitely, frozen on the last decoded frame, since nothing else ever tells the
  // OS to close it once the underlying video is torn down. Deliberately scoped to [nowPlaying]
  // only (not bufferProfile/reloadTick) so an internal same-channel reload — a network
  // reconnect, the audio-transcode fallback — doesn't unexpectedly kick the user out of PiP.
  useEffect(() => {
    const video = videoRef.current
    return () => {
      if (video && document.pictureInPictureElement === video) {
        document.exitPictureInPicture().catch(() => {})
      }
    }
  }, [nowPlaying])

  // Same reasoning as the PiP cleanup above: closing the player or switching channels while
  // fullscreen would otherwise leave the OS in fullscreen mode with nothing meaningful behind
  // it (the player itself is what's fullscreened, not the whole app window).
  useEffect(() => {
    return () => {
      if (document.fullscreenElement === playerRef.current) {
        document.exitFullscreen().catch(() => {})
      }
    }
  }, [nowPlaying])

  if (!nowPlaying) return null

  // A bitmap subtitle codec (PGS, VobSub, ...) can never be switched to — confirmed live to
  // crash the whole transcode if attempted (see switchSubtitleTrack's own comment) — so the
  // language button's visibility and its cycling both key off this, not the raw track count.
  const switchableSubtitleTracks = subtitleTracks.filter((t) => t.supported)

  async function togglePip(): Promise<void> {
    const video = videoRef.current
    if (!video) return
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else {
        await video.requestPictureInPicture()
      }
    } catch {
      // PiP can reject if the video isn't ready yet or the platform doesn't support it —
      // not worth surfacing as an error, the button just won't visibly do anything.
    }
  }

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await playerRef.current?.requestFullscreen()
      }
    } catch {
      // Same rationale as PiP above — not worth surfacing as a user-facing error.
    }
  }

  function togglePlayPause(): void {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  }

  // Clamped to the video's own seekable range rather than an arbitrary bound — for a live HLS
  // stream that's the DVR buffer hls.js maintains (so this doubles as an "instant replay"/
  // catch-up-within-the-buffer control), and for VOD/series it's just [0, duration].
  function skip(deltaSeconds: number): void {
    const video = videoRef.current
    if (!video || video.seekable.length === 0) return
    const target = video.currentTime + deltaSeconds
    const min = video.seekable.start(0)
    const max = video.seekable.end(video.seekable.length - 1)
    video.currentTime = Math.min(max, Math.max(min, target))
  }

  // The end of the seekable range IS the live edge for a live HLS stream — hls.js keeps
  // extending it as new segments arrive, so jumping here after skip()ping backward (or just
  // falling behind from buffering) genuinely returns to the current transmission, not a fixed
  // point that drifts stale.
  function goToLive(): void {
    const video = videoRef.current
    if (!video || video.seekable.length === 0) return
    video.currentTime = video.seekable.end(video.seekable.length - 1)
    if (video.paused) video.play().catch(() => {})
  }

  function toggleMute(): void {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
  }

  // Cycles Off -> first language -> second -> ... -> Off, entirely client-side and free/instant
  // — every track this cycles through is already loaded in the current source's own playlist,
  // unlike the separate 🌐 button below (driven by subtitleTracks/switchSubtitleTrack), which
  // picks a *different* language to transcode with and restarts the whole transcode to do it.
  // A single-track source degrades to a plain on/off toggle automatically (cycling past the one
  // track lands back on Off either way), so this replaces what used to be a separate, simpler
  // toggle-only function without needing two code paths for the two cases.
  function cycleHlsSubtitleTrack(): void {
    const hls = hlsRef.current
    if (!hls || hlsSubtitleTracks.length === 0) return
    const currentIndex = hlsSubtitleTracks.findIndex((t) => t.id === hls.subtitleTrack)
    const nextIndex = currentIndex + 1
    hls.subtitleTrack = nextIndex >= hlsSubtitleTracks.length ? -1 : hlsSubtitleTracks[nextIndex].id
  }

  // Unlike subtitles there's no "off" state for audio — a source with alternate audio renditions
  // still always has exactly one active — so this only ever cycles forward and wraps, never
  // lands on an explicit off.
  function cycleHlsAudioTrack(): void {
    const hls = hlsRef.current
    if (!hls || hlsAudioTracks.length < 2) return
    const currentIndex = hlsAudioTracks.findIndex((t) => t.id === hls.audioTrack)
    const nextIndex = (currentIndex + 1) % hlsAudioTracks.length
    hls.audioTrack = hlsAudioTracks[nextIndex].id
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const video = videoRef.current
    if (!video) return
    video.volume = Number(e.target.value)
    if (video.volume > 0 && video.muted) video.muted = false
  }

  // Live only — VOD/series render native <video controls>, which already give a plain click
  // play/pause and a double-click fullscreen toggle for free (confirmed live), so adding our own
  // here would just fight the native behavior. The bottom zone doubles as the in-video EPG
  // toggle, reachable without the mouse ever leaving the video; .player-overlay is always a
  // fixed, full-viewport layer (see global.css) so window.innerHeight is the right measure in
  // both windowed and fullscreen mode.
  function handlePlayAreaClick(e: React.MouseEvent<HTMLVideoElement>): void {
    if (nowPlaying?.kind !== 'live') return
    if (e.clientY > window.innerHeight - BOTTOM_ZONE_PX) {
      setShowChannelBar(!showChannelBar)
      return
    }
    togglePlayPause()
  }

  return (
    <div className="player-overlay" ref={playerRef}>
      <div
        className={`player-header player-header--overlay${!headerVisible ? ' player-header--hidden' : ''}`}
      >
        <span className="player-title">
          {nowPlaying.name}
          {/* Same persistent warning-while-not-connected indicator as the top bar — visible
              here too since the player can cover the whole screen, including in fullscreen,
              where the top bar itself is never reachable. Same click-to-toggle behavior too
              (toggleVpnTunnel in the store) — reachable without leaving playback, including
              fullscreen, unlike the Settings modal this used to open instead. */}
          {vpnHasProfiles && (
            <button
              className={`vpn-dot-button vpn-dot vpn-dot--${vpnStatus} player-title-vpn-dot`}
              onClick={() => void toggleVpnTunnel()}
              title={
                vpnStatus === 'connected'
                  ? 'VPN connected — click to disconnect'
                  : vpnStatus === 'connecting'
                    ? 'VPN connecting… — click to cancel'
                    : vpnStatus === 'error'
                      ? 'VPN error — click to reconnect'
                      : 'VPN not connected — click to connect'
              }
            />
          )}
        </span>
        <div className="player-header-actions">
          {// Play/pause and skip are only added here for live TV — VOD/series already have full
          // scrubbing via the native <video controls> bar below, and duplicating a second set
          // of transport controls there would be redundant, not additive.
          nowPlaying.kind === 'live' && (
            <>
              <button className="player-control-btn" onClick={() => skip(-SKIP_SECONDS_LONG)} title={`Back ${SKIP_SECONDS_LONG}s`}>
                ⏪ 1m
              </button>
              <button className="player-control-btn" onClick={() => skip(-SKIP_SECONDS)} title={`Back ${SKIP_SECONDS}s`}>
                ⏪ {SKIP_SECONDS}s
              </button>
              <button className="player-control-btn" onClick={togglePlayPause} title={paused ? 'Play' : 'Pause'}>
                {paused ? '▶' : '⏸'}
              </button>
              <button className="player-control-btn" onClick={() => skip(SKIP_SECONDS)} title={`Forward ${SKIP_SECONDS}s`}>
                {SKIP_SECONDS}s ⏩
              </button>
              <button className="player-control-btn" onClick={() => skip(SKIP_SECONDS_LONG)} title={`Forward ${SKIP_SECONDS_LONG}s`}>
                1m ⏩
              </button>
              <button className="player-control-btn" onClick={goToLive} title="Jump to the current live transmission">
                🔴 Live
              </button>
            </>
          )}
          <div className="player-volume">
            <button className="player-control-btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
            </button>
            <input
              type="range"
              className="player-volume-slider"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={handleVolumeChange}
              title="Volume"
            />
          </div>
          {hlsAudioTracks.length > 1 && (
            <button className="player-control-btn" onClick={cycleHlsAudioTrack} title="Switch audio language">
              🗣 {hlsAudioTracks.find((t) => t.id === activeHlsAudioTrack)?.name ?? 'Audio'}
            </button>
          )}
          {hlsSubtitleTracks.length > 0 && (
            <button
              className="player-control-btn"
              onClick={cycleHlsSubtitleTrack}
              title={
                hlsSubtitleTracks.length > 1
                  ? 'Cycle subtitle language (or off)'
                  : activeHlsSubtitleTrack === -1
                    ? 'Turn subtitles on'
                    : 'Turn subtitles off'
              }
            >
              💬 {activeHlsSubtitleTrack === -1 ? 'CC Off' : (hlsSubtitleTracks.find((t) => t.id === activeHlsSubtitleTrack)?.name ?? 'CC On')}
            </button>
          )}
          {// Only ever shown when this title's source genuinely has more than one *convertible*
          // subtitle track (see SubtitleTrackInfo.supported — a bitmap codec like PGS can't be
          // switched to at all, confirmed live to crash the whole transcode if attempted) —
          // switching means restarting the whole transcode fallback (see switchSubtitleTrack's
          // own comment for why this app's ffmpeg build can't just carry every language at
          // once), so this is deliberately a separate, clearly-labeled action from the free/
          // instant CC on/off toggle above.
          switchableSubtitleTracks.length > 1 && (
            <button
              className="player-control-btn"
              onClick={() =>
                switchSubtitleTrack(
                  nowPlaying.url,
                  () => setReloadTick((t) => t + 1),
                  (message) => setPlaybackError(`Failed to switch subtitle language: ${message}`)
                )
              }
              title="Switch subtitle language (restarts the audio/playback fix, can take a minute or two)"
            >
              🌐{' '}
              {subtitleTracks.find((t) => t.index === activeSubtitleTrackIndex)?.language?.toUpperCase() ??
                `Track ${activeSubtitleTrackIndex + 1}`}
            </button>
          )}
          <button
            className="player-control-btn"
            onClick={() => setStatsVisible((v) => !v)}
            title={statsVisible ? 'Hide stream stats' : 'Show stream stats'}
          >
            📊 Stats
          </button>
          <button className="player-control-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {isFullscreen ? '⛶ Exit Fullscreen' : '⛶ Fullscreen'}
          </button>
          <button className="player-pip" onClick={togglePip} title="Picture in picture">
            {pipActive ? '⧉ Exit PiP' : '⧉ PiP'}
          </button>
          <button className="player-close" onClick={stop}>
            ✕ Close
          </button>
        </div>
      </div>
      <div className="player-body">
        {!isOnline && (
          <div className="player-error">No network connection — will resume automatically once you're back online.</div>
        )}
        {playbackError && isOnline && <div className="player-error">{playbackError}</div>}
        {transcoding && !playbackError && (
          <div className="player-buffering">
            <div className="spinner" />
            <span>
              {nowPlaying.kind === 'live'
                ? 'Fixing audio for this channel…'
                : // "Fixing playback," not "fixing audio" — this same fallback also covers a
                  // title Chromium's <video> element can't make sense of at all (e.g. an .mkv
                  // container), not just a silent-audio-only codec problem, and the wording
                  // shouldn't imply audio is specifically what's wrong for the other case.
                  `Fixing playback for this title… this can take a minute or two on a slow connection (${formatElapsed(transcodeElapsedSeconds)})`}
              {nowPlaying.kind !== 'live' &&
                singleConnectionAccount &&
                transcodeElapsedSeconds >= SINGLE_CONNECTION_HINT_AFTER_SECONDS && (
                  <>
                    <br />
                    This account only allows one connection at a time — if something else is using it, this fix
                    can take longer than usual, or fail.
                  </>
                )}
            </span>
          </div>
        )}
        {buffering && !playbackError && !transcoding && (
          <div className="player-buffering">
            <div className="spinner" />
            <span>Buffering…</span>
          </div>
        )}
        <video
          ref={videoRef}
          className="player-video"
          // Native controls fight the channel bar on live: clicking the bottom strip (where
          // native controls render) gets consumed by their shadow DOM and never reaches this
          // onClick, and clicking anywhere else still double-fires the browser's own
          // click-to-pause behavior alongside our toggle, freezing the stream. Seeking/pausing
          // isn't meaningful on a live feed anyway, so controls stay off for live and on for
          // VOD/series, which still need them to scrub.
          controls={nowPlaying.kind !== 'live'}
          autoPlay
          onClick={handlePlayAreaClick}
          // Live-only: VOD/series keep the browser's own native double-click-to-fullscreen
          // behavior on their <video controls> for free (confirmed live), so adding our own here
          // too would just race it. Live has no native controls to provide that, so it gets our
          // own custom (playerRef-based, header-and-all) fullscreen toggle instead — closing the
          // player is still available via the header's Close button.
          onDoubleClick={() => {
            if (nowPlaying?.kind === 'live') void toggleFullscreen()
          }}
        />
        {// Hidden while the channel bar/EPG is open (both anchor to the bottom edge, and the
        // channel bar already shows its own sense of "when" via the EPG grid's now-line) and
        // unless the cursor is actually near the bottom edge — see the mousemove effect above.
        nowPlaying.kind === 'live' && !showChannelBar && cursorNearBottom && <PlayerSeekBar videoRef={videoRef} />}
        {showChannelBar && <PlayerChannelBar />}
        {statsVisible && <PlayerStatsOverlay videoRef={videoRef} hlsRef={hlsRef} />}
      </div>
      {/* Rendered here too (App.tsx also mounts one) since .player-overlay is a fixed,
          full-viewport layer that covers everything else, fullscreen or not — without this,
          an unexpected VPN drop while actively watching would show no warning at all. */}
      <VpnWarnings />
    </div>
  )
}
