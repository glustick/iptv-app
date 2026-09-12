import { useCallback, useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { useAppStore } from '../store/useAppStore'
import { PlayerChannelBar } from './PlayerChannelBar'
import { PlayerStatsOverlay } from './PlayerStatsOverlay'
import { PlayerSeekBar } from './PlayerSeekBar'
import { VpnWarnings } from './VpnWarnings'
import { useTranscodeFallback } from '../lib/useTranscodeFallback'
import { useNumericChannelEntry } from '../lib/useNumericChannelEntry'
import { useToolbarOverflow } from '../lib/useToolbarOverflow'
import { useHoverAutoHide } from '../lib/useHoverAutoHide'
import type { VideoScaleMode } from '../lib/types'

const MAX_NETWORK_RETRIES = 4
// A short pause before actually retrying a failed network load, rather than reloading the
// instant the previous attempt failed. Some causes of a "fatal" NETWORK_ERROR resolve on their
// own within a couple of seconds (a live playlist's segment sequence briefly not reconciling
// against the previous one, e.g. when the provider's own encoder restarts) — with no delay at
// all, hls.js's own internal escalation of a non-fatal parsing/playlist issue straight to fatal
// (there being no alternate quality level for it to switch to instead, per this app's own
// established finding that these providers serve one flat rendition per channel — see
// getLevelSwitchAction in hls.js's error-controller) could burn through every one of
// MAX_NETWORK_RETRIES within a fraction of a second, giving up long before the same brief blip
// would have cleared on its own.
const NETWORK_RETRY_DELAY_MS = 2000
const MAX_MEDIA_ERROR_RECOVERIES = 3
const ERROR_RESET_AFTER_MS = 15000
const PROGRESS_SAVE_INTERVAL_MS = 5000
const CHANNEL_BAR_AUTO_HIDE_MS = 6000
// Mirrors .player-channel-bar's own fixed CSS height exactly — used to test cursor position
// against the bar's footprint (see the hover-tracking effect below) without needing to measure
// the actual DOM element, which only exists while the bar is rendered at all.
const CHANNEL_BAR_HEIGHT_PX = 206
// Same auto-hide-after-a-delay idea as the channel bar above, but for the header, seek bar, and
// left-edge channel info panel — all three are purely hover-driven (see useHoverAutoHide), and
// all three share this one delay (5s per explicit request) rather than each having its own,
// unlike the channel bar's separately-tuned CHANNEL_BAR_AUTO_HIDE_MS above.
const HOVER_AUTO_HIDE_MS = 5000
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
// every content kind — cursor in the top 15% of the player (or at least 90px, to ensure a
// generous hit target on scaled displays where 10% was barely taller than the 60px toolbar itself)
// shows it, moving away hides it again, no click needed.
const HEADER_REVEAL_ZONE_FRACTION = 0.15
const HEADER_MIN_ZONE_PX = 90
// Same idea as the header above, but along the left edge and live-only: cursor in the left 10%
// of the player reveals the channel info panel (icon, name, current programme + description),
// moving away hides it again. A fraction of the player's own width for the same reason the
// header uses a height fraction — tracks "left 10%" regardless of window size.
const CHANNEL_INFO_ZONE_FRACTION = 0.1
// Cycle order for the aspect-ratio/zoom button — maps directly onto <video>'s own object-fit
// values (see VideoScaleMode in lib/types.ts).
const VIDEO_SCALE_MODES: VideoScaleMode[] = ['contain', 'cover', 'fill']
const VIDEO_SCALE_MODE_LABELS: Record<VideoScaleMode, string> = { contain: 'Fit', cover: 'Zoom', fill: 'Stretch' }
// Sleep timer preset cycle, in minutes — null is "off". Same click-to-cycle interaction as the
// aspect-ratio button above, rather than a dropdown, for consistency with this header's existing
// controls.
const SLEEP_TIMER_OPTIONS_MINUTES: (number | null)[] = [null, 15, 30, 60, 90]

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}


export function Player(): JSX.Element | null {
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const stop = useAppStore((s) => s.stop)
  const play = useAppStore((s) => s.play)
  const findChannelByNumber = useAppStore((s) => s.findChannelByNumber)
  const bufferProfile = useAppStore((s) => s.settings.bufferProfile)
  const persistedVolume = useAppStore((s) => s.settings.playerVolume)
  const persistedMuted = useAppStore((s) => s.settings.playerMuted)
  const videoScaleMode = useAppStore((s) => s.settings.videoScaleMode)
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
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const loadShortEpg = useAppStore((s) => s.loadShortEpg)
  const liveAudioFixes = useAppStore((s) => s.settings.liveAudioFixes)
  const rememberLiveAudioFix = useAppStore((s) => s.rememberLiveAudioFix)
  const forgetLiveAudioFix = useAppStore((s) => s.forgetLiveAudioFix)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const playerRef = useRef<HTMLDivElement | null>(null)
  // Mirrors "is playerRef.current actually attached right now" as real React state, purely so
  // useHoverAutoHide's effects (which key off it, alongside their own `enabled`) have a genuine
  // dependency change to react to once the node exists — a confirmed real bug otherwise: this
  // component's own instance never unmounts across a close/reopen (it returns null before
  // anything plays), so a plain useRef + a useEffect with an unchanging dependency array (e.g.
  // the header's `enabled` is a hardcoded `true`) runs exactly once, on that very first render,
  // with the ref still null — and never gets another chance to attach its listeners once the
  // node genuinely appears. (channelInfoVisible/cursorNearBottom happened to dodge this by luck:
  // their own `enabled` already flips false→true once a live channel starts, which is itself a
  // real dependency change — but relying on that coincidence for every future caller isn't
  // something to build on.) playerRef itself stays a plain ref — every other existing use of
  // `playerRef.current` throughout this file is unaffected.
  const [playerMounted, setPlayerMounted] = useState(false)
  // A stable callback ref, deliberately — an inline arrow here changes identity on every render,
  // and React answers that by calling the old ref with null and the new one with the node on
  // every single commit. That null-then-node dance transiently queues playerMounted
  // false→true, flipping every useHoverAutoHide call site's `enabled` and needlessly detaching
  // and re-attaching all their window listeners render after render. With one stable identity,
  // this callback genuinely runs only on real mount/unmount of .player-overlay.
  const attachPlayerRef = useCallback((node: HTMLDivElement | null) => {
    playerRef.current = node
    setPlayerMounted(node !== null)
  }, [])
  // Detects actual overflow on the controls row itself (scrollWidth > clientWidth), not a fixed
  // window/header width — .player-header spans the full player edge-to-edge regardless of how
  // little room is actually left for buttons once a (possibly long) title takes its share, so a
  // width-threshold on the header itself wouldn't reliably reflect whether the *buttons*
  // genuinely fit. A live multi-feature channel can have well over a dozen buttons active at
  // once; this drops to icon-only once they don't actually fit at full label width, regardless
  // of how wide the window is otherwise.
  const [controlsRef, headerCompact] = useToolbarOverflow<HTMLDivElement>()
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [buffering, setBuffering] = useState(false)
  const [pipActive, setPipActive] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [statsVisible, setStatsVisible] = useState(false)
  // Header, seek bar, and channel info panel are all purely hover-driven overlays with the exact
  // same real bug otherwise: a plain position-only mousemove handler has no way to notice the
  // cursor leaving the window entirely (no more mousemove events ever fire once it's outside the
  // document), so whichever one happened to be visible at that moment stayed stuck visible
  // forever — confirmed live, reported for the channel info panel specifically, but the same gap
  // applies to all three. useHoverAutoHide (see its own doc comment) fixes this once, reused
  // three times rather than three separate bespoke mousemove effects each missing the same case.
  const [headerVisible, setHeaderVisible] = useHoverAutoHide(
    playerRef,
    (e, rect) => e.clientY < rect.top + Math.max(rect.height * HEADER_REVEAL_ZONE_FRACTION, HEADER_MIN_ZONE_PX),
    HOVER_AUTO_HIDE_MS,
    Boolean(playerMounted && nowPlaying)
  )
  const [cursorNearBottom] = useHoverAutoHide(
    playerRef,
    (e, rect) => e.clientY > rect.top + rect.height * (1 - SEEKBAR_REVEAL_ZONE_FRACTION),
    HOVER_AUTO_HIDE_MS,
    playerMounted && nowPlaying?.kind === 'live'
  )
  const [channelInfoVisible] = useHoverAutoHide(
    playerRef,
    (e, rect) => e.clientX < rect.left + rect.width * CHANNEL_INFO_ZONE_FRACTION,
    HOVER_AUTO_HIDE_MS,
    playerMounted && nowPlaying?.kind === 'live'
  )
  // null = off. A global "stop watching after N minutes" timer, not tied to any one channel —
  // deliberately survives a channel switch (see the effect below) since the point is winding
  // down a viewing session, not this specific channel. Player.tsx's own instance never actually
  // unmounts across a close/reopen (nowPlaying just goes null and the component returns null —
  // see resetTranscodeFallback's own comment for the same gotcha), so this needs its own explicit
  // reset-on-close rather than relying on fresh initial state.
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null)
  const [sleepTimerRemainingSeconds, setSleepTimerRemainingSeconds] = useState<number | null>(null)
  // Set briefly when a typed channel number (see useNumericChannelEntry below) has no match.
  const [numberNotFound, setNumberNotFound] = useState<number | null>(null)
  // hls.js's own, free/instant notion of "which renditions does the CURRENT source's playlist
  // carry" — populated from Hls.Events.SUBTITLE_TRACKS_UPDATED, which fires for *any* m3u8 with
  // #EXT-X-MEDIA:TYPE=SUBTITLES entries, live or not: a genuinely multi-language live channel's
  // own master playlist works exactly the same way here as the transcode fallback's own
  // (VOD/series-only, always exactly one track) generated one does — hls.js doesn't distinguish
  // the two. (See vodSubtitleTracks/switchVodSubtitleTrack below for the separate, ffmpeg-level
  // notion of "which language could this be transcoded with" — that one restarts the whole
  // transcode to switch; this one is just picking among renditions the current source already
  // offers.)
  const [hlsSubtitleTracks, setHlsSubtitleTracks] = useState<{ id: number; name: string }[]>([])
  const [activeHlsSubtitleTrack, setActiveHlsSubtitleTrack] = useState(-1)
  // Same idea as hlsSubtitleTracks above, but for #EXT-X-MEDIA:TYPE=AUDIO — unlike subtitles
  // there's no "off" state (a source with alternate audio renditions still always has exactly
  // one active), so this only ever needs a track to cycle through, never an on/off toggle.
  const [hlsAudioTracks, setHlsAudioTracks] = useState<{ id: number; name: string }[]>([])
  const [activeHlsAudioTrack, setActiveHlsAudioTrack] = useState(-1)
  const wasOffline = useRef(false)
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read by the auto-hide effect below, not a dependency of it — a ref rather than state
  // specifically so cursor movement over the bar doesn't re-run that effect (and thus
  // needlessly reset/rearm the timer) on every pixel; the position-tracking effect further
  // below manages the timer directly instead.
  const channelBarHovered = useRef(false)
  // Every real mousemove over the player while the channel bar is open, regardless of whether it
  // crossed the bar's own footprint boundary — read on window focus (see onWindowFocus below) to
  // reconcile against where the cursor actually last was, the same reasoning useHoverAutoHide's
  // own lastMouseEventRef documents.
  const channelBarLastMouseEvent = useRef<MouseEvent | null>(null)
  const lastStreamKeyRef = useRef<string | null>(null)
  const [transcodeElapsedSeconds, setTranscodeElapsedSeconds] = useState(0)

  const {
    transcoding,
    getSourceUrl,
    tryFallback,
    tryFallbackForSilentAudio,
    reset: resetTranscodeFallback,
    beginRun: beginTranscodeRun,
    hasFallbackActive,
    liveAudioTracks,
    probingLiveAudio,
    activeLiveAudioTrackIndex,
    probedLiveSubtitleTrackCount,
    probeLiveAudioTracks,
    switchLiveAudioTrack,
    vodAudioTracks,
    vodSubtitleTracks,
    probingVodTracks,
    activeVodAudioIndex,
    activeVodSubtitleIndex,
    probeVodTracks,
    switchVodAudioTrack,
    switchVodSubtitleTrack
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
    let errorResetTimer: ReturnType<typeof setTimeout> | null = null
    let networkRetryTimer: ReturnType<typeof setTimeout> | null = null
    let progressInterval: ReturnType<typeof setInterval> | null = null
    let silentAudioCheckTimer: ReturnType<typeof setInterval> | null = null

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const handleWaiting = (): void => {
      setBuffering(true)
      // Still recovering — don't let a stretch of genuinely uninterrupted playback earlier
      // in the session forgive an error that's actively recurring right now.
      if (errorResetTimer) {
        clearTimeout(errorResetTimer)
        errorResetTimer = null
      }
    }
    const handlePlaying = (): void => {
      setBuffering(false)
      // A stretch of real, uninterrupted playback means whatever caused an earlier media or
      // network error is very likely no longer happening — reset both recovery counts so a
      // later, unrelated blip gets its own full set of attempts instead of inheriting counts
      // left over from a problem that already resolved itself. Previously only the media-error
      // count was ever reset here — networkRetryCount had no reset at all, so a channel that hit
      // occasional, individually-harmless network blips spread out over a long viewing session
      // (each one recovering fine on its own) could still eventually exhaust MAX_NETWORK_RETRIES
      // and fatally give up on one that would otherwise have recovered exactly like the others.
      if (errorResetTimer) clearTimeout(errorResetTimer)
      errorResetTimer = setTimeout(() => {
        mediaErrorRecoveryCount = 0
        networkRetryCount = 0
      }, ERROR_RESET_AFTER_MS)
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
        manifestLoadingMaxRetry: 6,
        // Fixes a real, reported "levelParsingError, gave up after 4 tries" on a channel that
        // was confirmed live to actually be fine (playable elsewhere). Root-caused directly
        // against the real account/channel (Sky News, via this provider): the channel's live
        // playlist doesn't refresh with a consistently mergeable segment-sequence timeline —
        // essentially every reload disagreed with the previous one enough for hls.js's own
        // internal reconciliation to call it a "media sequence mismatch" and, since this
        // provider serves one flat rendition per channel (no alternate quality level for hls.js
        // to fall back to instead — an established finding elsewhere in this app), immediately
        // escalate that from a non-fatal event straight to a fatal one. Confirmed live that this
        // isn't a rare blip either: it recurred roughly every playlist refresh (~10s) for over a
        // minute straight, and neither a resume-in-place retry nor even a full teardown-and-
        // recreate of the whole hls.js instance (tried first, before this) ever avoided hitting
        // the identical mismatch again shortly after — the provider's playlist itself doesn't
        // present a timeline hls.js's stricter reconciliation can ever agree with, regardless of
        // how fresh the player's own state is. This is exactly what hls.js's own (off-by-
        // default) ignorePlaylistParsingErrors option exists for: it only suppresses this class
        // of "couldn't reconcile/verify structural details of an already-loading level's
        // playlist" issue (checked directly against hls.js 1.7.1's own source — every one of its
        // few emission sites is individually gated behind this exact flag), not a genuinely
        // empty/malformed playlist (that still surfaces as its own distinct, ungated
        // LEVEL_EMPTY_ERROR/MANIFEST_PARSING_ERROR either way) — i.e. it makes this player
        // tolerate the same kind of playlist inconsistency other, less strict players already
        // silently do, without also silencing a genuinely broken stream.
        ignorePlaylistParsingErrors: true
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
            () => {
              // Remux confirmed working — remember it for this live channel so the next open
              // skips detection entirely (see the apply-remembered-audio-fix effect below).
              // audioIndex 0 = the remux's default first audio track.
              if (nowPlaying.kind === 'live') rememberLiveAudioFix(nowPlaying.streamId, 0, nowPlaying.url)
              setReloadTick((t) => t + 1)
            },
            (message) => {
              // A failed remux invalidates whatever was remembered (self-healing: the next
              // open re-detects, and re-records only on success).
              if (nowPlaying.kind === 'live') forgetLiveAudioFix(nowPlaying.streamId)
              setPlaybackError(`Audio codec not supported by this player, and automatic transcoding failed: ${message}`)
            }
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
              if (networkRetryTimer) clearTimeout(networkRetryTimer)
              networkRetryTimer = setTimeout(() => hls.startLoad(), NETWORK_RETRY_DELAY_MS)
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

      // Live TV's own version of the silent-audio poll below (the VOD/series `else` branch).
      // The hls ERROR handler above catches unsupported audio when hls.js or Chromium's
      // SourceBuffer *reports* it (fragParsingError, bufferAddCodecError, ...) — but some
      // channels' audio fails without any error event at all: the video track decodes and plays
      // fine while the audio track silently produces nothing, leaving no signal on video.error,
      // in the console, or in any hls.js event. Confirmed shape from the VOD side of the same
      // failure (webkitAudioDecodedByteCount stays pinned at 0); the only reliable detector is
      // polling those decode counters, so run the exact same 2-consecutive-tick check here for
      // live channels and hand it to the same ffmpeg AAC remux. Deliberately does NOT also run
      // the "never decoded anything at all" timeout branch — a live channel that never decodes
      // video is a network/playlist problem the fatal error paths above already own, and this
      // poll shouldn't second-guess them on the way past.
      let liveSilentAudioTicks = 0
      let liveSilentAudioCheckAttempts = 0
      silentAudioCheckTimer = setInterval(() => {
        liveSilentAudioCheckAttempts += 1
        const chromiumVideo = video as ChromiumVideoElement
        const videoBytes = chromiumVideo.webkitVideoDecodedByteCount ?? 0
        const audioBytes = chromiumVideo.webkitAudioDecodedByteCount ?? 0
        liveSilentAudioTicks = videoBytes > 0 && audioBytes === 0 ? liveSilentAudioTicks + 1 : 0
        if (liveSilentAudioTicks < 2) {
          // Give up quietly once the check budget is spent without ever confirming the symptom
          // (channel is fine, or its failure was already handled by the error paths above).
          if (liveSilentAudioCheckAttempts >= SILENT_AUDIO_MAX_CHECK_ATTEMPTS && silentAudioCheckTimer) {
            clearInterval(silentAudioCheckTimer)
            silentAudioCheckTimer = null
          }
          return
        }
        if (silentAudioCheckTimer) clearInterval(silentAudioCheckTimer)
        silentAudioCheckTimer = null
        // Same single-connection contention story as the VOD path below: stop the current
        // stream from pulling any more of the original URL before ffmpeg opens its own
        // connection to it (see CONNECTION_RELEASE_DELAY_MS) — hls.stopLoad() halts segment
        // fetching without tearing the instance down (the reload after the fallback resolves
        // rebuilds everything anyway).
        video.pause()
        hls.stopLoad()
        silentAudioCheckTimer = setTimeout(() => {
          silentAudioCheckTimer = null
          const started = tryFallbackForSilentAudio(
            nowPlaying.url,
            () => {
              // Remux confirmed working — remember it so this channel never pays the
              // detect-wait again (see the apply-remembered-audio-fix effect below).
              rememberLiveAudioFix(nowPlaying.streamId, 0, nowPlaying.url)
              setReloadTick((t) => t + 1)
            },
            (message) => {
              forgetLiveAudioFix(nowPlaying.streamId)
              setPlaybackError(`Audio codec not supported by this player, and automatic transcoding failed: ${message}`)
            },
            // Live TV: isVod false, so the fallback remux uses Live's short-segment-window HLS
            // output (see startTranscode) rather than VOD's event playlist.
            false
          )
          // Declined means a fallback for this channel already ran (e.g. the ERROR handler
          // above kicked one off, or this IS the transcoded output still coming out silent) —
          // nothing new will replace the stream we just paused and detached from, so resume it
          // rather than leaving a frozen frame with no explanation.
          if (!started) {
            video.play().catch(() => {})
            hls.startLoad()
          }
        }, CONNECTION_RELEASE_DELAY_MS)
      }, SILENT_AUDIO_CHECK_INTERVAL_MS)
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
      if (errorResetTimer) clearTimeout(errorResetTimer)
      if (networkRetryTimer) clearTimeout(networkRetryTimer)
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

  // A live channel with a remembered audio fix (settings.liveAudioFixes) opens straight into
  // the ffmpeg remux instead of re-running detection: without this, every visit to a channel
  // whose audio needs the fallback paid the full discovery cost again — up to ~10s of
  // silent-audio polling or waiting for an hls error, plus the 8s connection-release delay,
  // plus ffmpeg startup — every single time, despite the app having already learned exactly
  // what that channel needs. The original stream keeps playing in the meantime (its video is
  // fine; only the audio is broken) and swaps to the remux the moment it's ready — the exact
  // flow the automatic detection paths already use, minus the wait to detect. Deliberately
  // declared after the main playback effect above so beginTranscodeRun() has already reset the
  // in-flight flag this turn. The remembered fix records the exact URL it was confirmed
  // against; a mismatch (token rotation, a timeshift variant of the same channel) safely
  // skips this and falls back to normal detection rather than remuxing the wrong source.
  useEffect(() => {
    if (!nowPlaying || nowPlaying.kind !== 'live') return
    if (hasFallbackActive || transcoding) return
    const fix = liveAudioFixes[String(nowPlaying.streamId)]
    if (!fix || fix.url !== nowPlaying.url) return
    switchLiveAudioTrack(
      nowPlaying.url,
      fix.audioIndex,
      () => {
        rememberLiveAudioFix(nowPlaying.streamId, fix.audioIndex, fix.url)
        setReloadTick((t) => t + 1)
      },
      (message) => {
        // The remembered remux no longer works for this channel (provider-side change, most
        // likely) — forget it so the next open re-detects from scratch instead of retrying a
        // fix that just failed.
        forgetLiveAudioFix(nowPlaying.streamId)
        setPlaybackError(`Audio codec not supported by this player, and automatic transcoding failed: ${message}`)
      }
    )
  }, [nowPlaying, liveAudioFixes, hasFallbackActive, transcoding, switchLiveAudioTrack, rememberLiveAudioFix, forgetLiveAudioFix])

  // Keep the display from sleeping while something is genuinely being watched — an IPTV app
  // that lets the OS blank the screen mid-match is missing something every hardware set-top
  // box just does. `paused` is synced from the video element itself (see syncPlayState in the
  // playback effect), so the programmatic pause during an audio-fix transcode would otherwise
  // release the blocker right in the middle of a wait the user is actively staring at — hence
  // the transcoding exemption. A playback error or closing the player releases it; Multi-View
  // tiles deliberately don't engage it (a muted browse grid isn't "watching"). The main
  // process also force-stops the blocker on quit, in case the renderer dies mid-playback.
  useEffect(() => {
    const watching = Boolean(nowPlaying) && !playbackError && (!paused || transcoding)
    // The resolved value (the main process's post-call isActive echo) is deliberately unused —
    // this is fire-and-forget state sync, idempotent on both ends.
    void window.api.keepAwake.setEnabled(watching)
  }, [nowPlaying, paused, playbackError, transcoding])

  // The channel bar auto-hides after a few seconds of inactivity, like a real set-top box's
  // channel banner — but is genuinely paused, not just re-armed, while the cursor is over it
  // (see the position-tracking effect below). Skips arming the timer at all if the cursor is
  // already there the moment this effect runs (e.g. the bar reopening under a cursor that never
  // left the bottom of the screen).
  useEffect(() => {
    if (autoHideTimer.current) clearTimeout(autoHideTimer.current)
    autoHideTimer.current = null
    if (!showChannelBar) return

    const container = playerRef.current
    const lastEvent = channelBarLastMouseEvent.current
    if (container && lastEvent) {
      channelBarHovered.current = lastEvent.clientY > container.getBoundingClientRect().bottom - CHANNEL_BAR_HEIGHT_PX
    }
    if (channelBarHovered.current) return

    autoHideTimer.current = setTimeout(() => {
      autoHideTimer.current = null
      channelBarHovered.current = false
      setShowChannelBar(false)
    }, CHANNEL_BAR_AUTO_HIDE_MS)
    return () => {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current)
      autoHideTimer.current = null
    }
  }, [showChannelBar, nowPlaying])

  // Tracks whether the cursor is within the channel bar's own footprint by position (the same
  // pattern the seek bar/header hover-reveal effects already use below), not via the bar's own
  // DOM node's mouseenter/mouseleave — confirmed live that approach doesn't hold up: its rows
  // are virtualized (react-window), and a scroll-triggered row swap under an otherwise-stationary
  // cursor can fire a native mouseout with relatedTarget: null, which reads identically to the
  // cursor genuinely leaving the container as far as React's mouseleave polyfill can tell, and
  // did fire a spurious auto-hide in practice while actively browsing.
  useEffect(() => {
    const container = playerRef.current
    if (!container || !showChannelBar) return
    function scheduleHide(): void {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current)
      autoHideTimer.current = setTimeout(() => {
        autoHideTimer.current = null
        channelBarHovered.current = false
        setShowChannelBar(false)
      }, CHANNEL_BAR_AUTO_HIDE_MS)
    }
    function onMouseMove(e: MouseEvent): void {
      channelBarLastMouseEvent.current = e
      const rect = container!.getBoundingClientRect()
      const overBar = e.clientY > rect.bottom - CHANNEL_BAR_HEIGHT_PX
      if (overBar === channelBarHovered.current) return
      channelBarHovered.current = overBar
      if (overBar) {
        if (autoHideTimer.current) {
          clearTimeout(autoHideTimer.current)
          autoHideTimer.current = null
        }
      } else {
        scheduleHide()
      }
    }
    // Cursor leaving the whole window/document is a case the mousemove tracking above can never
    // see on its own — no more mousemove events fire once it's outside the document — so without
    // this, the bar could stay open indefinitely if the cursor left while still over its
    // footprint (the same real gap useHoverAutoHide's own doc comment documents, fixed the same
    // way here since the channel bar's own auto-hide is click-toggled, not purely hover-shown,
    // and so doesn't use that hook directly). relatedTarget === null is what distinguishes
    // "left the document" from "moved to a different element still inside it."
    function onDocumentMouseOut(e: MouseEvent): void {
      if (e.relatedTarget !== null || !channelBarHovered.current) return
      channelBarHovered.current = false
      scheduleHide()
    }
    // Same idea, for a case document mouseout can't see either: fullscreen on one monitor while
    // the cursor works in a different, unfocused window on a second one — the cursor never
    // crosses this window's bounds at all, so neither mousemove nor mouseout ever fires, and the
    // bar would otherwise stay open for as long as the other window has focus (confirmed live as
    // a real, reported bug on exactly that two-monitor setup — see useHoverAutoHide's own doc
    // comment for the identical fix applied there).
    function onWindowBlur(): void {
      if (!channelBarHovered.current) return
      channelBarHovered.current = false
      scheduleHide()
    }
    // Reconciles against the last known cursor position on refocus — confirmed live as a real,
    // reported regression on Windows specifically (see useHoverAutoHide's own doc comment for the
    // full account): Windows simply doesn't deliver mousemove to an unfocused window at all, so a
    // cursor genuinely still resting over the bar's footprint when the window regains focus would
    // otherwise still get closed by whatever hide timer blur already armed, with nothing left to
    // cancel it since no further mousemove ever arrives to say otherwise.
    function onWindowFocus(): void {
      const lastEvent = channelBarLastMouseEvent.current
      const rect = container!.getBoundingClientRect()
      const overBar = lastEvent ? lastEvent.clientY > rect.bottom - CHANNEL_BAR_HEIGHT_PX : false
      channelBarHovered.current = overBar
      if (overBar) {
        if (autoHideTimer.current) {
          clearTimeout(autoHideTimer.current)
          autoHideTimer.current = null
        }
      } else if (!autoHideTimer.current) {
        scheduleHide()
      }
    }
    container.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseout', onDocumentMouseOut)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    return () => {
      container.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseout', onDocumentMouseOut)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current)
      autoHideTimer.current = null
    }
  }, [showChannelBar])

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
  // (see the useHoverAutoHide call above), in both windowed and fullscreen mode alike.
  useEffect(() => {
    setHeaderVisible(true)
  }, [nowPlaying, setHeaderVisible])

  // The channel info panel needs this channel's short EPG (for the current programme's title
  // and description) on hand before the cursor ever reaches the left edge — fetching it lazily
  // on first hover would mean showing nothing (or a stale previous channel's listings) for a
  // beat. loadShortEpg de-dupes against both an already-cached entry and an in-flight fetch (see
  // its own definition), so this is safe to call again on every channel change without guarding
  // here too.
  useEffect(() => {
    if (nowPlaying?.kind === 'live') void loadShortEpg(nowPlaying.streamId)
  }, [nowPlaying, loadShortEpg])

  // VOD/series probes its own audio/subtitle tracks automatically on load (unlike Live TV's
  // manual button — see probeVodTracks' own comment for why the two differ) against the
  // original URL, never the transcoded one: probing is what decides whether a transcode even
  // starts, so there's nothing else to probe against yet.
  useEffect(() => {
    if (nowPlaying && nowPlaying.kind !== 'live') {
      void probeVodTracks(nowPlaying.url, (message) =>
        console.error('[transcode] failed to probe VOD tracks:', message)
      )
    }
  }, [nowPlaying, probeVodTracks])

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

  // The sleep timer counts down independent of channel switches (it's about winding down a
  // viewing session, not any one channel) — only resetting to off when the player actually
  // closes. Since this component's own instance never unmounts across a close/reopen, "closes"
  // has to be detected explicitly as a nowPlaying transition from something to null, rather than
  // relying on fresh initial state the way a real unmount/remount would give for free.
  const wasPlayingRef = useRef(false)
  useEffect(() => {
    if (wasPlayingRef.current && !nowPlaying) setSleepTimerMinutes(null)
    wasPlayingRef.current = !!nowPlaying
  }, [nowPlaying])

  useEffect(() => {
    if (sleepTimerMinutes === null) {
      setSleepTimerRemainingSeconds(null)
      return
    }
    setSleepTimerRemainingSeconds(sleepTimerMinutes * 60)
    const interval = setInterval(() => {
      setSleepTimerRemainingSeconds((prev) => {
        if (prev === null) return null
        if (prev <= 1) {
          clearInterval(interval)
          stop()
          setSleepTimerMinutes(null)
          return null
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
    // Deliberately scoped to sleepTimerMinutes only — re-triggering on every render (or on
    // nowPlaying changing) would reset the countdown back to the full duration on every channel
    // switch, defeating the entire point of a sleep timer surviving them.
  }, [sleepTimerMinutes])

  function cycleSleepTimer(): void {
    const currentIndex = SLEEP_TIMER_OPTIONS_MINUTES.indexOf(sleepTimerMinutes)
    setSleepTimerMinutes(SLEEP_TIMER_OPTIONS_MINUTES[(currentIndex + 1) % SLEEP_TIMER_OPTIONS_MINUTES.length])
  }

  // Channel-surfing-by-number while actually watching, the more iconic version of the same
  // feature EpgGridPanel.tsx offers while just browsing — live-only, matching every other
  // channel-switching affordance in this header (skip/live-jump buttons are live-only too).
  useEffect(() => {
    if (numberNotFound === null) return
    const timer = setTimeout(() => setNumberNotFound(null), 2000)
    return () => clearTimeout(timer)
  }, [numberNotFound])

  const numericEntryDisplay = useNumericChannelEntry((num) => {
    void findChannelByNumber(num).then((channel) => {
      if (channel) play('live', channel.stream_id, channel.name, 'm3u8', channel.stream_icon, channel.tv_archive)
      else setNumberNotFound(num)
    })
  }, nowPlaying?.kind === 'live')

  if (!nowPlaying) return null

  // The "currently playing" programme out of this channel's short EPG listings — the one whose
  // window actually contains right now, not just the first entry (get_short_epg can return
  // listings starting slightly in the future, e.g. right at a programme boundary).
  const nowPlayingProgram =
    nowPlaying.kind === 'live'
      ? (shortEpgByStream[nowPlaying.streamId] ?? []).find(
          (p) => Number(p.start_timestamp) * 1000 <= Date.now() && Number(p.stop_timestamp) * 1000 > Date.now()
        )
      : undefined

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

  // Persisted (not just session-local) the same way volume/mute already are — a global
  // preference rather than tracked per-channel, applied uniformly whenever anything plays.
  function cycleVideoScaleMode(): void {
    const currentIndex = VIDEO_SCALE_MODES.indexOf(videoScaleMode)
    updateSettings({ videoScaleMode: VIDEO_SCALE_MODES[(currentIndex + 1) % VIDEO_SCALE_MODES.length] })
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
    // Clicking near the top edge in live mode (where the toolbar lives) toggles/reveals
    // the controls rather than pausing, providing an immediate mouse fallback if hover
    // tracking is interrupted by OS boundary events.
    if (e.clientY < Math.max(window.innerHeight * HEADER_REVEAL_ZONE_FRACTION, HEADER_MIN_ZONE_PX)) {
      setHeaderVisible(!headerVisible)
      return
    }
    togglePlayPause()
  }

  return (
    <div
      className="player-overlay"
      ref={attachPlayerRef}
    >
      <div className={`player-header player-header--overlay${!headerVisible ? ' player-header--hidden' : ''}`}>
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
        <div className={`player-header-actions${headerCompact ? ' player-header-actions--compact' : ''}`}>
          {// The scrollable/shrinkable group — everything except Close. min-width: 0 (see CSS)
          // is what lets this actually shrink below its content's natural width instead of
          // pushing Close out of the header; headerCompact (useToolbarOverflow, detecting real
          // overflow on this row directly) drops text labels first, and if a pathologically
          // narrow width still doesn't fit every icon, this scrolls horizontally within itself
          // rather than ever hiding Close.
          }
          <div className="player-header-controls" ref={controlsRef}>
            {// Play/pause and skip work identically for live TV (clamped to the DVR buffer) and
            // VOD/series (clamped to [0, duration]) — see skip()'s own comment. Jumping to the
            // live edge is the only piece that's live-only, since VOD/series has no such concept
            // — it still keeps the native <video controls> bar below for full scrubbing, these
            // buttons are additive for quick skips without reaching for the scrub bar.
            }
            <button className="player-control-btn" onClick={() => skip(-SKIP_SECONDS_LONG)} title={`Back ${SKIP_SECONDS_LONG}s`}>
              ⏪ <span className="control-label">1m</span>
            </button>
            <button className="player-control-btn" onClick={() => skip(-SKIP_SECONDS)} title={`Back ${SKIP_SECONDS}s`}>
              ⏪ <span className="control-label">{SKIP_SECONDS}s</span>
            </button>
            <button className="player-control-btn" onClick={togglePlayPause} title={paused ? 'Play' : 'Pause'}>
              {paused ? '▶' : '⏸'}
            </button>
            <button className="player-control-btn" onClick={() => skip(SKIP_SECONDS)} title={`Forward ${SKIP_SECONDS}s`}>
              <span className="control-label">{SKIP_SECONDS}s</span> ⏩
            </button>
            <button className="player-control-btn" onClick={() => skip(SKIP_SECONDS_LONG)} title={`Forward ${SKIP_SECONDS_LONG}s`}>
              <span className="control-label">1m</span> ⏩
            </button>
            {nowPlaying.kind === 'live' && (
              <button className="player-control-btn" onClick={goToLive} title="Jump to the current live transmission">
                🔴 <span className="control-label">Live</span>
              </button>
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
            {// hls.js's own, free/instant alternate-audio renditions — every option here is
            // already loaded in the current source's own playlist, so picking one is just
            // `hls.audioTrack = id`, no restart of anything.
            hlsAudioTracks.length > 1 && (
              <label className="player-track-select" title="Audio language">
                <span aria-hidden="true">🗣</span>
                <span className="control-label">Audio</span>
                <select
                  value={activeHlsAudioTrack}
                  onChange={(e) => {
                    const hls = hlsRef.current
                    if (hls) hls.audioTrack = Number(e.target.value)
                  }}
                >
                  {hlsAudioTracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {// A live channel's raw stream can carry audio tracks its HLS playlist never
            // advertises at all — hlsAudioTracks (above) only ever sees what the playlist
            // declares, so this covers the gap for channels where that's empty/single but the
            // actual multiplex has more (confirmed live: a real "5.1 + Stereo"-labeled channel
            // whose playlist advertised one rendition but whose raw stream carried three). Hidden
            // once hlsAudioTracks already found more than one (nothing left to check), or while a
            // *different* transcode fallback (the automatic codec fix) is already active — but not
            // once this block's own switchLiveAudioTrack is what's driving hasFallbackActive
            // (liveAudioTracks !== null exactly identifies that case), or a user who's already
            // picked a track could never see which one, or switch to another. Unlike VOD's
            // probeVodTracks (automatic on load), this stays gated behind an explicit "Check Audio
            // Tracks" button — probing hits a second connection, and doing that unprompted for
            // every one of a large live catalog's channels isn't worth it for what's usually a
            // "no." Only once that check has actually run does this become a real dropdown
            // listing every track found, rather than a button that only ever showed the current
            // one — a proactive probe with a reactive-looking button underneath was the original
            // complaint here.
            nowPlaying.kind === 'live' && hlsAudioTracks.length <= 1 && (!hasFallbackActive || liveAudioTracks !== null) && (
              liveAudioTracks === null ? (
                <button
                  className="player-control-btn"
                  disabled={probingLiveAudio}
                  onClick={() =>
                    void probeLiveAudioTracks(nowPlaying.url, (message) =>
                      setPlaybackError(`Failed to check for extra audio tracks: ${message}`)
                    )
                  }
                  title="Check whether this channel actually carries more audio tracks than its guide lists (opens a second connection briefly)"
                >
                  🎚 <span className="control-label">{probingLiveAudio ? 'Checking…' : 'Check Audio Tracks'}</span>
                </button>
              ) : (
                <label
                  className="player-track-select"
                  title={
                    liveAudioTracks.length > 1
                      ? 'Switch to a different audio track found in this channel’s raw stream (restarts playback via a local remux, can take a few seconds)'
                      : `No extra audio tracks found in this channel's raw stream${probedLiveSubtitleTrackCount ? ` (${probedLiveSubtitleTrackCount} subtitle track${probedLiveSubtitleTrackCount > 1 ? 's' : ''} found, not yet switchable for Live TV)` : ' (no embedded subtitle tracks either)'}`
                  }
                >
                  <span aria-hidden="true">🎚</span>
                  <span className="control-label">Audio</span>
                  <select
                    value={liveAudioTracks.length > 1 ? (activeLiveAudioTrackIndex ?? 0) : -1}
                    disabled={liveAudioTracks.length <= 1}
                    onChange={(e) => {
                      const index = Number(e.target.value)
                      if (index === (activeLiveAudioTrackIndex ?? 0)) return
                      switchLiveAudioTrack(
                        nowPlaying.url,
                        index,
                        () => {
                          // A hand-picked track is remembered exactly like the automatic
                          // fallback's default one, so reopening the channel restores it.
                          rememberLiveAudioFix(nowPlaying.streamId, index, nowPlaying.url)
                          setReloadTick((t) => t + 1)
                        },
                        (message) => {
                          forgetLiveAudioFix(nowPlaying.streamId)
                          setPlaybackError(`Failed to switch audio track: ${message}`)
                        }
                      )
                    }}
                  >
                    {liveAudioTracks.length <= 1 ? (
                      <option value={-1}>No Extra Audio</option>
                    ) : (
                      liveAudioTracks.map((t) => (
                        <option key={t.index} value={t.index}>
                          {`${t.language?.toUpperCase() ?? `Track ${t.index + 1}`} (${t.codec.toUpperCase()}, ${t.channelLayout})`}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              )
            )}
            {// Same free/instant hls.js rendition-picking as the audio dropdown above, plus an
            // explicit Off option — unlike VOD's subtitle dropdown (driven by
            // vodSubtitleTracks/switchVodSubtitleTrack), which picks a *different* language to
            // transcode with and restarts the whole transcode to do it, this is just
            // `hls.subtitleTrack = id`, already loaded in the current source's own playlist.
            hlsSubtitleTracks.length > 0 && (
              <label className="player-track-select" title="Subtitles">
                <span aria-hidden="true">💬</span>
                <span className="control-label">Subtitles</span>
                <select
                  value={activeHlsSubtitleTrack}
                  onChange={(e) => {
                    const hls = hlsRef.current
                    if (hls) hls.subtitleTrack = Number(e.target.value)
                  }}
                >
                  <option value={-1}>Off</option>
                  {hlsSubtitleTracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {// VOD/series track selection is a pair of dropdowns rather than the click-to-cycle
            // buttons Live TV uses above — every option is visible up front, and switching either
            // one restarts the whole transcode fallback (via switchVodAudioTrack/
            // switchVodSubtitleTrack) carrying the OTHER dimension's current pick along unchanged.
            // Tracks are probed automatically on load (see the probeVodTracks effect above), so
            // these render as soon as nowPlaying flips to VOD/series, disabled until that resolves.
            nowPlaying.kind !== 'live' && (
              <>
                <label className="player-track-select" title="Audio track">
                  <span aria-hidden="true">🗣</span>
                  <span className="control-label">Audio</span>
                  <select
                    value={activeVodAudioIndex}
                    disabled={probingVodTracks || !vodAudioTracks || vodAudioTracks.length <= 1}
                    onChange={(e) => {
                      const index = Number(e.target.value)
                      if (index === activeVodAudioIndex) return
                      switchVodAudioTrack(
                        nowPlaying.url,
                        index,
                        () => setReloadTick((t) => t + 1),
                        (message) => setPlaybackError(`Failed to switch audio track: ${message}`)
                      )
                    }}
                  >
                    {probingVodTracks && <option>Checking…</option>}
                    {!probingVodTracks && !vodAudioTracks && <option>Audio</option>}
                    {!probingVodTracks &&
                      vodAudioTracks?.length === 0 && <option value={activeVodAudioIndex}>No audio tracks found</option>}
                    {vodAudioTracks?.map((t) => (
                      <option key={t.index} value={t.index}>
                        {`${t.language?.toUpperCase() ?? `Track ${t.index + 1}`} (${t.codec.toUpperCase()}, ${t.channelLayout})`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="player-track-select" title="Subtitles">
                  <span aria-hidden="true">💬</span>
                  <span className="control-label">Subtitles</span>
                  <select
                    value={activeVodSubtitleIndex}
                    disabled={probingVodTracks || !vodSubtitleTracks || vodSubtitleTracks.filter((t) => t.supported).length === 0}
                    onChange={(e) => {
                      const index = Number(e.target.value)
                      if (index === activeVodSubtitleIndex) return
                      switchVodSubtitleTrack(
                        nowPlaying.url,
                        index,
                        () => setReloadTick((t) => t + 1),
                        (message) => setPlaybackError(`Failed to switch subtitle track: ${message}`)
                      )
                    }}
                  >
                    <option value={-1}>Off</option>
                    {probingVodTracks && <option disabled>Checking…</option>}
                    {vodSubtitleTracks?.map((t) => (
                      <option key={t.index} value={t.index} disabled={!t.supported}>
                        {`${t.language?.toUpperCase() ?? `Track ${t.index + 1}`}${t.supported ? '' : ' (unsupported)'}`}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <button
              className="player-control-btn"
              onClick={cycleVideoScaleMode}
              title="Cycle aspect ratio: Fit (letterboxed) → Zoom (crops to fill) → Stretch (fills exactly, may distort)"
            >
              🔲 <span className="control-label">{VIDEO_SCALE_MODE_LABELS[videoScaleMode]}</span>
            </button>
            <button
              className="player-control-btn"
              onClick={cycleSleepTimer}
              title="Cycle sleep timer: stops playback automatically after the chosen time"
            >
              ⏾{' '}
              <span className="control-label">
                {sleepTimerMinutes === null
                  ? 'Sleep Timer'
                  : sleepTimerRemainingSeconds !== null
                    ? formatCountdown(sleepTimerRemainingSeconds)
                    : `${sleepTimerMinutes}m`}
              </span>
            </button>
            <button
              className="player-control-btn"
              onClick={() => setStatsVisible((v) => !v)}
              title={statsVisible ? 'Hide stream stats' : 'Show stream stats'}
            >
              📊 <span className="control-label">Stats</span>
            </button>
            <button className="player-control-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              ⛶ <span className="control-label">{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>
            </button>
            <button className="player-pip" onClick={togglePip} title="Picture in picture">
              ⧉ <span className="control-label">{pipActive ? 'Exit PiP' : 'PiP'}</span>
            </button>
          </div>
          <button className="player-close" onClick={stop} title="Close">
            ✕ <span className="control-label">Close</span>
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
        {(numericEntryDisplay || numberNotFound !== null) && (
          <div className="numeric-entry-overlay">
            {numericEntryDisplay ? `Channel ${numericEntryDisplay}` : `Channel ${numberNotFound} not found`}
          </div>
        )}
        {// Left-edge hover panel, live-only — see the channelInfoVisible mousemove effect above.
        // Deliberately pointer-events: none (see global.css) so it never intercepts the
        // click-to-pause/double-click-to-fullscreen handlers on the video underneath it.
        nowPlaying.kind === 'live' && (
          <div
            className={`player-channel-info-panel${channelInfoVisible ? ' player-channel-info-panel--visible' : ''}`}
          >
            {nowPlaying.icon ? (
              <img className="player-channel-info-icon" src={nowPlaying.icon} alt="" />
            ) : (
              <span className="player-channel-info-icon placeholder" />
            )}
            <div className="player-channel-info-name">{nowPlaying.name}</div>
            {nowPlayingProgram && (
              <>
                <div className="player-channel-info-program">{nowPlayingProgram.title}</div>
                {nowPlayingProgram.description && (
                  <div className="player-channel-info-description">{nowPlayingProgram.description}</div>
                )}
              </>
            )}
          </div>
        )}
        <video
          ref={videoRef}
          className="player-video"
          style={{ objectFit: videoScaleMode }}
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
