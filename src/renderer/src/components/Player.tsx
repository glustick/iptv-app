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
// Click-zone thresholds for fullscreen mode, in pixels from the respective screen edge —
// roughly matched to the header's own height and the channel bar's (see CHANNEL_BAR height in
// global.css) so each zone lines up with the chrome it reveals rather than an arbitrary split.
// Deliberately independent from SEEKBAR_REVEAL_ZONE_FRACTION just below, even though both sit
// near the bottom edge: this one is click-triggered and fullscreen-only (opens the EPG channel
// bar), while the seek bar's is hover-triggered and applies in windowed mode too — a fixed
// pixel count wouldn't scale sensibly there. They don't currently conflict (a click still
// reaches the video first; the seek bar only intercepts a much thinner strip right at its own
// edge), but if either threshold changes, sanity-check the other still makes sense next to it.
const FULLSCREEN_BOTTOM_ZONE_PX = 220
const FULLSCREEN_TOP_ZONE_PX = 80
// The seek bar itself reveals on hover/cursor position (not click, unlike the header/channel
// bar above) — a fraction of the player's own height rather than a fixed pixel count so it
// scales sensibly whether the player is windowed or truly fullscreen.
const SEEKBAR_REVEAL_ZONE_FRACTION = 0.2
// VOD/series' fullscreen header (unlike Live's, which stays click-toggled — see
// handlePlayAreaClick) reveals purely on cursor position, the same hover-driven shape as the
// seek bar above rather than FULLSCREEN_TOP_ZONE_PX's fixed pixel count, since it's meant to
// track "top 10% of the screen" regardless of window size.
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
  const openSettings = useAppStore((s) => s.openSettings)
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
  const [fullscreenHeaderVisible, setFullscreenHeaderVisible] = useState(false)
  const [statsVisible, setStatsVisible] = useState(false)
  const [cursorNearBottom, setCursorNearBottom] = useState(false)
  // hls.js's own on/off state for whichever single subtitle rendition the CURRENT transcode
  // session carries (see subtitleTracks/switchSubtitleTrack below for the different, ffmpeg-
  // level notion of "which language is this" — this is just "is it showing right now," and is
  // free/instant, unlike switching languages which restarts the whole transcode). Only ever
  // populated for VOD/series titles whose audio-fix fallback detected and carried through an
  // embedded subtitle track — Live TV never has one, and most VOD/series never need the
  // fallback at all.
  const [hlsSubtitleTracks, setHlsSubtitleTracks] = useState<{ id: number; name: string }[]>([])
  const [activeHlsSubtitleTrack, setActiveHlsSubtitleTrack] = useState(-1)
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
      // renditions, if any, it references — a no-op for every stream except a VOD/series title
      // whose transcode fallback carried one through. Defaults to whatever hls.js auto-selected
      // (the master playlist's own DEFAULT=YES marks the fallback's track that way), which is
      // why subtitles already showed up with no explicit code enabling them.
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
        setHlsSubtitleTracks(data.subtitleTracks.map((t) => ({ id: t.id, name: t.name || `Track ${t.id + 1}` })))
      })
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_event, data) => {
        setActiveHlsSubtitleTrack(data.id)
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

  // The header starts hidden every time fullscreen is entered and is simply always visible
  // again once fullscreen ends, matching its normal in-flow, always-on windowed-mode appearance.
  // How it's *revealed* while fullscreen differs by content kind: Live keeps the original
  // click-the-top-edge toggle (see handlePlayAreaClick); VOD/series instead follows cursor
  // position purely (see the next effect below), the mousemove effect after that immediately
  // overriding this starting value the moment the cursor actually moves.
  useEffect(() => {
    setFullscreenHeaderVisible(!isFullscreen)
  }, [isFullscreen])

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

  // VOD/series' fullscreen header: purely hover-driven, unlike Live's click-toggle (see
  // handlePlayAreaClick) — cursor in the top 10% of the player reveals it, moving away
  // instantly hides it again, no click needed. Only wired up in fullscreen; windowed mode's
  // header stays permanently visible regardless of content kind, unchanged from before.
  useEffect(() => {
    const container = playerRef.current
    if (!container || !isFullscreen || nowPlaying?.kind === 'live') return
    function onMouseMove(e: MouseEvent): void {
      const rect = container!.getBoundingClientRect()
      setFullscreenHeaderVisible(e.clientY < rect.top + rect.height * HEADER_REVEAL_ZONE_FRACTION)
    }
    container.addEventListener('mousemove', onMouseMove)
    return () => container.removeEventListener('mousemove', onMouseMove)
  }, [nowPlaying, isFullscreen])

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

  // The Settings modal renders at App's root, outside this player's own DOM subtree — while
  // truly fullscreen (the Fullscreen API only paints the fullscreened element and its
  // descendants), opening it without exiting first would set the store's settingsOpen flag with
  // nothing actually visible on screen to show for it.
  async function openVpnSettingsFromPlayer(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {})
    }
    openSettings()
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

  // A plain on/off toggle, not a picker: confirmed directly (see useTranscodeFallback.ts's
  // switchSubtitleTrack) that this app's ffmpeg build can only ever carry one subtitle
  // rendition per transcode session, so hls.js itself never has more than one track to choose
  // between here — picking a *different* language means restarting the whole transcode, not
  // switching among tracks already loaded, which is what the separate language button below
  // (driven by subtitleTracks/switchSubtitleTrack) is for.
  function toggleHlsSubtitleTrack(): void {
    const hls = hlsRef.current
    if (!hls || hlsSubtitleTracks.length === 0) return
    hls.subtitleTrack = hls.subtitleTrack === -1 ? hlsSubtitleTracks[0].id : -1
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const video = videoRef.current
    if (!video) return
    video.volume = Number(e.target.value)
    if (video.volume > 0 && video.muted) video.muted = false
  }

  // Windowed mode keeps the old behavior (click anywhere on a live channel toggles the channel
  // bar) unchanged — the header is always visible there, so there's no "reveal the chrome"
  // concern to split zones for. Fullscreen replaces that with a top/bottom split: the header
  // (translucent, hidden by default) is normally out of reach once it's hidden, so a click has
  // to land somewhere to bring it back, and the bottom zone doubles as the in-video EPG toggle
  // so it's reachable without a mouse ever leaving the video.
  function handlePlayAreaClick(e: React.MouseEvent<HTMLVideoElement>): void {
    if (isFullscreen) {
      // VOD/series' header is purely hover-driven now (see the mousemove effect above) — a
      // click here would just fight that, immediately re-hiding what hovering just revealed.
      if (e.clientY < FULLSCREEN_TOP_ZONE_PX && nowPlaying?.kind === 'live') {
        setFullscreenHeaderVisible((v) => !v)
        return
      }
      if (e.clientY > window.innerHeight - FULLSCREEN_BOTTOM_ZONE_PX) {
        if (nowPlaying?.kind === 'live') setShowChannelBar(!showChannelBar)
        return
      }
      return
    }
    if (nowPlaying?.kind === 'live') setShowChannelBar(!showChannelBar)
  }

  return (
    <div className="player-overlay" ref={playerRef}>
      <div
        className={`player-header${isFullscreen ? ' player-header--overlay' : ''}${isFullscreen && !fullscreenHeaderVisible ? ' player-header--hidden' : ''}`}
        // Once revealed, the header itself covers the same top zone that opened it — a second
        // click there lands on the header, not the video underneath, so closing it again has to
        // be handled here too. Ignores clicks on an actual control (button/input) so pressing
        // e.g. Pause doesn't also immediately hide the header out from under the next click.
        onClick={(e) => {
          if (!isFullscreen) return
          if ((e.target as HTMLElement).closest('button, input')) return
          setFullscreenHeaderVisible(false)
        }}
      >
        <span className="player-title">
          {nowPlaying.name}
          {/* Same persistent warning-while-not-connected indicator as the top bar — visible
              here too since the player can cover the whole screen, including in fullscreen,
              where the top bar itself is never reachable. */}
          {vpnHasProfiles && (
            <button
              className={`vpn-dot-button vpn-dot vpn-dot--${vpnStatus} player-title-vpn-dot`}
              onClick={() => void openVpnSettingsFromPlayer()}
              title={
                (vpnStatus === 'connected'
                  ? 'VPN connected'
                  : vpnStatus === 'connecting'
                    ? 'VPN connecting…'
                    : vpnStatus === 'error'
                      ? 'VPN error — check Settings'
                      : 'VPN not connected') + ' — click to open VPN settings'
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
          {hlsSubtitleTracks.length > 0 && (
            <button
              className="player-control-btn"
              onClick={toggleHlsSubtitleTrack}
              title={activeHlsSubtitleTrack === -1 ? 'Turn subtitles on' : 'Turn subtitles off'}
            >
              💬 {activeHlsSubtitleTrack === -1 ? 'CC Off' : 'CC On'}
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
          // behavior on their <video controls>, and "back to the EPG" isn't a meaningful
          // concept for something that was never browsed from the EPG grid to begin with.
          onDoubleClick={() => {
            if (nowPlaying?.kind === 'live') stop()
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
