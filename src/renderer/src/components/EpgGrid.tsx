import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { List, useListRef } from 'react-window'
import { useAppStore } from '../store/useAppStore'
import { useResizableWidth } from '../lib/useResizableWidth'
import { pct } from '../lib/epgTime'
import { channelKey } from '../lib/channelIdentity'
import { findAlsoOnCandidates, type AlsoOnCandidate } from '../lib/crossPlaylist'
import { describeVideoFailure } from '../lib/undecodableVideo'
import { describeChannelHealth } from '../lib/channelHealth'
import {
  buildProgrammeDetail,
  NO_DESCRIPTION_LABEL,
  programmeWatchAction
} from '../lib/programmeDetail'
import type { LiveStream, ShortEpgProgram, ClockFormat } from '../lib/types'

const HOUR_MS = 3_600_000
const WINDOW_HOURS = 3
const MS_PER_SCROLL_UNIT = 30_000 // 30 seconds of time-shift per wheel delta unit
const MAX_WINDOW_OFFSET_MS = 24 * HOUR_MS // soft clamp — get_short_epg's own window is far narrower than this anyway
// Lower bound still fits the icon + a few characters of ellipsized name; upper bound leaves at
// least some width for the timeline itself in the narrowest real layout (the fullscreen channel
// bar, which shares this same column width — see epgChannelColumnWidth in lib/types.ts).
const CHANNEL_COLUMN_MIN_WIDTH = 90
const CHANNEL_COLUMN_MAX_WIDTH = 320
// A mousedown-drag on the timeline is indistinguishable from the start of an ordinary click
// (selecting a channel, opening a programme's catch-up) until the mouse actually moves — this is
// how far it has to travel before it's treated as a drag instead, matching the same small-slop
// idea most drag implementations use to avoid punishing a slightly-shaky click.
const DRAG_CLICK_THRESHOLD_PX = 4

function formatHour(t: number, clockFormat: ClockFormat): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', hour12: clockFormat === '12h' })
}

function formatTime(epochSeconds: string, clockFormat: ClockFormat): string {
  return new Date(Number(epochSeconds) * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: clockFormat === '12h'
  })
}

// 0.34.0: the ⏺ tooltip's start time, qualified by day — the grid reaches days ahead, and a bare
// "18:30" on something airing Thursday is the kind of half-truth that schedules the wrong thing.
// Today keeps the bare time (what "Record … (18:30)" always meant); tomorrow and this week name
// the day; anything further gets the date.
function formatStartLabel(epochSeconds: string, clockFormat: ClockFormat): string {
  const date = new Date(Number(epochSeconds) * 1000)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: clockFormat === '12h' })
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const daysAhead = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000)
  if (daysAhead === 0) return time
  if (daysAhead === 1) return `tomorrow ${time}`
  if (daysAhead <= 7) return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

// How many "Also on …" entries the context menu offers before it stops. More playlists than
// this carrying the same channel is a catalogue oddity, not a menu.
const MAX_ALSO_ON_ITEMS = 4

// The scheduled-recording entry for this programme, if one exists — matched by channel key,
// programme title AND listed start time, so two same-named programmes in a day's listings stay
// distinct. Pure so the block's render-side lookup is trivially correct.
function scheduledRecordingOf(
  channelId: string,
  program: ShortEpgProgram,
  recordings: { id: string; channelKey: string; programmeTitle?: string; startedAt: number; status: string }[]
): { id: string } | null {
  const hit = recordings.find(
    (r) =>
      r.status === 'scheduled' &&
      r.channelKey === channelId &&
      r.programmeTitle === program.title &&
      r.startedAt === Number(program.start_timestamp) * 1000
  )
  return hit ?? null
}

/** An open channel context menu: which channel, and where on screen it was opened. */
interface ChannelMenuState {
  channel: LiveStream
  x: number
  y: number
}

/** The programme-detail popover (0.45.0): which programme on which channel, plus the clicked
 *  block's viewport rect captured at open time. Like the context menu above, it lives at the
 *  grid level — one instance, above the virtualized rows — and the rect is stored as numbers
 *  rather than an element reference: by the time the popover renders, the row that opened it may
 *  have been recycled onto another channel, so re-reading the DOM would be a lie. */
interface ProgrammePopoverState {
  channel: LiveStream
  programme: ShortEpgProgram
  rect: { left: number; right: number; top: number; bottom: number }
}

// The popover's layout, sized generously for the ~200-character description cap (lib/
// programmeDetail) — used only to edge-clamp the captured anchor into the viewport, never to
// re-read the DOM.
const POPOVER_WIDTH = 340
const POPOVER_MAX_HEIGHT = 240
const POPOVER_MARGIN = 8
const POPOVER_GAP = 6

// Anchors the popover just below the clicked block and clamps it into the viewport, flipping
// above the block when there is no room below. Pure, so the flip rule reads next to the open
// handler; everything it works on was captured at open time (see ProgrammePopoverState).
function placePopover(
  rect: ProgrammePopoverState['rect'],
  viewportWidth: number,
  viewportHeight: number
): { left: number; top: number } {
  let left = rect.left
  if (left + POPOVER_WIDTH > viewportWidth - POPOVER_MARGIN) {
    left = viewportWidth - POPOVER_WIDTH - POPOVER_MARGIN
  }
  left = Math.max(POPOVER_MARGIN, left)
  let top = rect.bottom + POPOVER_GAP
  if (top + POPOVER_MAX_HEIGHT > viewportHeight - POPOVER_MARGIN) {
    top = Math.max(POPOVER_MARGIN, rect.top - POPOVER_MAX_HEIGHT - POPOVER_GAP)
  }
  return { left: Math.round(left), top: Math.round(top) }
}

interface RowProps {
  channels: LiveStream[]
  windowStart: number
  windowEnd: number
  now: number
  activeStreamId?: number
  focusedIndex: number
  clockFormat: ClockFormat
  onSelectChannel: (channel: LiveStream) => void
  onWatchFullscreen: (channel: LiveStream) => void
  // A click on a programme block — the row reports it up with the block's viewport rect rather
  // than acting itself, because the popover that click opens lives at the grid level (rows are
  // virtualized) and the grid is what decides open-vs-move-vs-play.
  onProgrammeBlockClick: (
    channel: LiveStream,
    program: ShortEpgProgram,
    rect: { left: number; right: number; top: number; bottom: number }
  ) => void
  // Right-click (or Ctrl+click / the keyboard Menu key) on a row — the row reports the event up
  // so the menu itself can live at the grid level, where it doesn't get recycled by
  // virtualization and doesn't need a copy per row.
  onChannelContextMenu: (e: React.MouseEvent, channel: LiveStream) => void
  isVideoFailed?: (channel: LiveStream) => boolean
}

function EpgRow({
  index,
  style,
  channels,
  windowStart,
  windowEnd,
  now,
  activeStreamId,
  focusedIndex,
  clockFormat,
  onSelectChannel,
  isVideoFailed,
  onWatchFullscreen,
  onProgrammeBlockClick,
  onChannelContextMenu
}: { index: number; style: CSSProperties } & RowProps): JSX.Element {
  const channel = channels[index]
  const primaryPlaylistId = useAppStore((s) => s.primaryPlaylistId)
  // This channel's playlist-aware key (see lib/channelIdentity) — every per-channel map below is
  // keyed by it, so the same numeric id on two playlists stays two different channels.
  const channelId = channelKey(channel.playlistId, channel.stream_id, primaryPlaylistId)
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const loadShortEpg = useAppStore((s) => s.loadShortEpg)
  const toggleEpgReminder = useAppStore((s) => s.toggleEpgReminder)
  const isEpgReminderSet = useAppStore((s) => s.isEpgReminderSet)
  const probeChannelHealth = useAppStore((s) => s.probeChannelHealth)
  const channelHealth = useAppStore((s) => s.channelHealthByStream[channelId])
  const scheduleRecording = useAppStore((s) => s.scheduleRecording)
  const cancelScheduledRecording = useAppStore((s) => s.cancelScheduledRecording)
  const recordings = useAppStore((s) => s.recordings)

  // Rows are virtualized, so this only fires for channels actually scrolled into view —
  // fine even against a 24k-channel catalog. This is also the workaround for providers
  // that block the full multi-channel xmltv.php guide (this app's own test account 403s
  // on it): get_short_epg is per-channel and part of the core Xtream API instead.
  useEffect(() => {
    // loadShortEpg catches its own errors internally (EPG is best-effort) and always resolves.
    // Passed this channel's own playlist so the fetch goes to the account that serves it.
    void loadShortEpg(channel.stream_id, channel.playlistId)
    // Same lazy, per-visible-row trigger for feed health: one small manifest request the first
    // time a channel is ever shown, then cached for the session (deduped, concurrency-capped and
    // cached inside the store — see probeChannelHealth). Fired from here rather than for a whole
    // category at once precisely because rows are virtualized: this asks about the channels the
    // user is actually looking at, at the rate they scroll.
    void probeChannelHealth(channel.stream_id, channel.playlistId)
  }, [channel.stream_id, channel.playlistId, loadShortEpg, probeChannelHealth])

  const listings = shortEpgByStream[channelId]
  const visible = (listings ?? []).filter(
    (p) => Number(p.stop_timestamp) * 1000 > windowStart && Number(p.start_timestamp) * 1000 < windowEnd
  )
  const isActive = activeStreamId === channel.stream_id
  const isFocused = index === focusedIndex
  const nowPct = pct(now, windowStart, windowEnd)
  const showNowLine = now >= windowStart && now <= windowEnd

  return (
    // Double-click anywhere in the row — not just the channel-name button — opens fullscreen.
    // Programme blocks call stopPropagation() on their own onClick (so clicking one doesn't
    // also select the row underneath), but that only suppresses the 'click' event; 'dblclick'
    // is dispatched separately and still bubbles up to this handler untouched.
    <div
      style={style}
      className={`epg-row${isActive ? ' active' : ''}${isFocused ? ' epg-row--focused' : ''}`}
      onDoubleClick={() => onWatchFullscreen(channel)}
      onContextMenu={(e) => onChannelContextMenu(e, channel)}
      title={`${channel.name} (double-click for fullscreen · right-click for options)`}
    >
      <div className="epg-row-channel-wrap">
        <button className="epg-row-channel" onClick={() => onSelectChannel(channel)}>
          {channel.stream_icon ? (
            <img src={channel.stream_icon} alt="" loading="lazy" />
          ) : (
            <span className="epg-row-channel-icon placeholder" />
          )}
          <span className="epg-row-channel-name">{channel.name}</span>
          {/* Which playlist this channel belongs to. Rendered only when more than one is connected
              (the stream is only tagged then — see selectCategory), so with a single provider the
              row is exactly as it was. Reported as the thing that keeps a merged view unambiguous. */}
          {channel.playlistName && (
            <span className="epg-playlist-badge" title={`From ${channel.playlistName}`}>
              {channel.playlistName}
            </span>
          )}
          {/* Only ever shown for a channel we have actually judged and found wanting — 'ok' and
              'unknown' both render nothing, so the normal case stays visually unchanged. */}
          {isVideoFailed?.(channel) && (
            <span className="epg-health-badge epg-health-badge--video" title={describeVideoFailure()}>
              ⊘
            </span>
          )}
          {channelHealth && (channelHealth.health === 'loop' || channelHealth.health === 'unavailable') && (
            <span
              className={`epg-health-badge epg-health-badge--${channelHealth.health}`}
              title={describeChannelHealth(channelHealth.health, channelHealth.durationSeconds) ?? undefined}
            >
              {channelHealth.health === 'loop' ? '⟳' : '⚠'}
            </span>
          )}
        </button>
      </div>
      <div className="epg-row-timeline">
        {listings === undefined && <div className="epg-row-loading" />}
        {listings !== undefined && visible.length === 0 && (
          // Loaded (or failed after a retry-able attempt — see loadShortEpg's catch) but
          // nothing covers this window: either the channel genuinely has no guide, or the
          // available data ends before this part of the timeline. An explicit label beats the
          // old behavior of an identical-looking blank row in every one of those cases.
          <span className="epg-row-empty">No programme data</span>
        )}
        {visible.map((p, i) => {
          const startMs = Number(p.start_timestamp) * 1000
          const stopMs = Number(p.stop_timestamp) * 1000
          const left = pct(startMs, windowStart, windowEnd)
          const width = Math.max(pct(stopMs, windowStart, windowEnd) - left, 2)
          const isPast = stopMs <= now
          const canCatchUp = isPast && channel.tv_archive === 1
          const isUpcoming = startMs > now
          const reminderSet = isEpgReminderSet(channel.stream_id, p.id, channel.playlistId)
          return (
            <span key={`${p.id}-${i}`}>
              <button
                className={`epg-block${isPast ? ' epg-block--past' : ''}${canCatchUp ? ' epg-block--catchup' : ''}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${formatTime(p.start_timestamp, clockFormat)} – ${formatTime(p.stop_timestamp, clockFormat)}\n${p.title}${p.description ? '\n' + p.description : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  // 0.45.0: the click no longer plays right away — it opens (or moves) the
                  // grid-level detail popover, and a second click on this same block takes the
                  // action (the grid decides which, via onProgrammeBlockClick). The rect is
                  // captured HERE, at click time: rows are virtualized, so by the time the
                  // popover renders, this element may already have been recycled onto another
                  // channel — only the captured numbers stay honest.
                  const rect = e.currentTarget.getBoundingClientRect()
                  onProgrammeBlockClick(channel, p, {
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom
                  })
                }}
              >
                <span className="epg-block-label">{p.title}</span>
              </button>
              {isUpcoming && (
                <button
                  className={`epg-reminder-button${reminderSet ? ' epg-reminder-button--set' : ''}`}
                  style={{ left: `calc(${left + width}% - 28px)` }}
                  title={reminderSet ? 'Remove programme reminder' : 'Set programme reminder'}
                  aria-label={reminderSet ? `Remove reminder for ${p.title}` : `Set reminder for ${p.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleEpgReminder(channel.stream_id, channel.name, p, channel.playlistId)
                  }}
                >
                  {reminderSet ? '🔔' : '🔕'}
                </button>
              )}
              {// ⏺ (0.29.0): schedule this programme to be recorded (the main process starts
              // ffmpeg preroll seconds before the listed start — see recordingService.schedule).
              // Matched back by channel + programme + start so the button reflects an existing
              // schedule and can cancel it.
              isUpcoming && (
                <button
                  className={`epg-reminder-button${scheduledRecordingOf(channelId, p, recordings) ? ' epg-reminder-button--set' : ''}`}
                  style={{ left: `calc(${left + width}% - 54px)` }}
                  title={
                    scheduledRecordingOf(channelId, p, recordings)
                      ? `Cancel scheduled recording of ${p.title}`
                      : `Record ${p.title} (starts ${formatStartLabel(p.start_timestamp, clockFormat)})`
                  }
                  aria-label={
                    scheduledRecordingOf(channelId, p, recordings)
                      ? `Cancel recording of ${p.title}`
                      : `Record ${p.title}`
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    const existing = scheduledRecordingOf(channelId, p, recordings)
                    if (existing) void cancelScheduledRecording(existing.id)
                    else void scheduleRecording(channel, p)
                  }}
                >
                  {scheduledRecordingOf(channelId, p, recordings) ? '⏹' : '⏺'}
                </button>
              )}
            </span>
          )
        })}
        {showNowLine && <div className="epg-now-indicator" style={{ left: `${nowPct}%` }} />}
      </div>
    </div>
  )
}

interface EpgGridProps {
  channels: LiveStream[]
  activeStreamId?: number
  clockFormat: ClockFormat
  rowHeight?: number
  compact?: boolean
  autoFocus?: boolean
  // Rendered at the right edge of the time header — used by EpgGridPanel to add its row-density
  // toggle without this shared component (also used by the much tighter fullscreen channel bar,
  // which never passes this) needing to know that setting exists.
  extraNavControls?: React.ReactNode
  // Row to scroll to once, right after the channel list first becomes non-empty — lets a caller
  // (PlayerChannelBar) land on a specific row (the currently-playing channel) instead of always
  // starting at the top. Omitted entirely by EpgGridPanel, which has no such row to scroll to.
  initialScrollIndex?: number
  onSelectChannel: (channel: LiveStream) => void
  onWatchFullscreen: (channel: LiveStream) => void
  onWatchTimeshift: (channel: LiveStream, program: ShortEpgProgram) => void
  /** Channels whose video this machine has already failed to decode (0.22.0) — the per-row
   *  verdict the panel's count could not give. */
  isVideoFailed?: (channel: LiveStream) => boolean
}

// The reusable Gantt-chart EPG guide: channels run down the vertical axis (virtualized, so
// it's fine against a large catalog), time runs left-to-right, and each programme is a
// positioned block sized by its duration. Used both as the main Live TV browsing surface
// (EpgGridPanel) and as the compact channel-swap overlay in the fullscreen player
// (PlayerChannelBar) — same grid, just a different number of visible rows.
export function EpgGrid({
  channels,
  activeStreamId,
  clockFormat,
  rowHeight = 40,
  compact = false,
  autoFocus = false,
  extraNavControls,
  initialScrollIndex,
  onSelectChannel,
  onWatchFullscreen,
  onWatchTimeshift,
  isVideoFailed
}: EpgGridProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [windowOffsetMs, setWindowOffsetMs] = useState(0)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const listRef = useListRef(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const appliedInitialScroll = useRef(false)
  // One menu at the grid level, not one per row: rows are recycled by the virtualizer, so a
  // menu living inside a row would be torn down (or reused for a different channel) the moment
  // it scrolled out of view.
  const [contextMenu, setContextMenu] = useState<ChannelMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  // The programme-detail popover (0.45.0) — same one-instance-at-grid-level reasoning as the
  // context menu above. The Escape chain (lib/overlays.ts) reads the STORE, not component state,
  // so the store carries a boolean mirror (programmeDetailOpen) that the effects below keep in
  // sync with this payload; Escape closing it is the one close path that bypasses this component,
  // and the second effect watches for exactly that and drops the payload.
  const [programmePopover, setProgrammePopover] = useState<ProgrammePopoverState | null>(null)
  const programmePopoverRef = useRef<ProgrammePopoverState | null>(null)
  const setProgrammeDetailOpen = useAppStore((s) => s.setProgrammeDetailOpen)
  const programmeDetailOpen = useAppStore((s) => s.programmeDetailOpen)
  // The popover's remind/record actions are the same ones the row's own bell/⏺ buttons call.
  const isEpgReminderSet = useAppStore((s) => s.isEpgReminderSet)
  const toggleEpgReminder = useAppStore((s) => s.toggleEpgReminder)
  const scheduleRecording = useAppStore((s) => s.scheduleRecording)
  const cancelScheduledRecording = useAppStore((s) => s.cancelScheduledRecording)
  const recordings = useAppStore((s) => s.recordings)

  // Shared by the main docked guide and the fullscreen channel-swap overlay (both render this
  // same component) — persisted so a name that was clipped once stays legible everywhere this
  // grid shows up, not just in whichever context it was resized from.
  const epgChannelColumnWidth = useAppStore((s) => s.settings.epgChannelColumnWidth)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const toggleHiddenLiveChannel = useAppStore((s) => s.toggleHiddenLiveChannel)
  const isChannelHidden = useAppStore((s) => s.isChannelHidden)
  const openEpgMatch = useAppStore((s) => s.openEpgMatch)
  // The "Also on …" switch (0.16.0): candidates come from the merged live catalogue, which
  // covers every connected playlist. It is built lazily on demand — usually already loaded for
  // numeric channel entry — so a null catalogue means this open shows no items and quietly
  // starts the load for the next one.
  const primaryPlaylistId = useAppStore((s) => s.primaryPlaylistId)
  const numericChannelCatalog = useAppStore((s) => s.numericChannelCatalog)
  const ensureChannelCatalog = useAppStore((s) => s.ensureChannelCatalog)
  const playChannel = useAppStore((s) => s.play)
  const { width: channelColumnWidth, startDrag: startChannelColumnDrag } = useResizableWidth(
    epgChannelColumnWidth,
    1,
    {
      min: CHANNEL_COLUMN_MIN_WIDTH,
      max: CHANNEL_COLUMN_MAX_WIDTH,
      onCommit: (w) => updateSettings({ epgChannelColumnWidth: w })
    }
  )

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  // The JSX `autoFocus` prop leans on the browser's native autofocus-on-parse behavior, which
  // only fires for elements present in the initial HTML parse — not for ones a React component
  // inserts later via the DOM API, which is exactly this case (the channel bar mounts
  // conditionally, well after the page's first render). Calling .focus() explicitly on mount
  // is the reliable way to get the same effect for a dynamically-mounted element.
  useEffect(() => {
    if (autoFocus) rootRef.current?.focus()
  }, [])

  // Closes the menu when the user clicks anywhere else. Deliberately a plain document listener
  // owned by this effect (added only while a menu is open) rather than an entry in App.tsx's
  // central overlay chain: that chain exists to order the app's *modals*, and this is a
  // transient popup that lives and dies with its own grid.
  useEffect(() => {
    if (!contextMenu) return
    // Focused so Escape is handled by the menu's own onKeyDown below — without this the key would
    // travel to App.tsx's document-level handler, which knows nothing about this menu and would
    // fall through to closing the preview or stopping playback behind it.
    contextMenuRef.current?.focus()
    function onDocMouseDown(e: MouseEvent): void {
      if ((e.target as HTMLElement | null)?.closest('.epg-context-menu')) return
      setContextMenu(null)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [contextMenu])

  // The popover's mirror: the store boolean follows this payload wherever THIS component takes
  // it (open, move, close, play) — written in the same synchronous breath as the payload, so
  // both batch into one render and nothing ever observes a payload without its mirror. (A
  // post-hoc sync effect can't do this: on the open commit itself the Escape-watcher below
  // would still see the stale mirror=false alongside a live payload and instantly close what
  // was just opened — found live in the first smoke run, where every popover vanished before
  // it could paint.) Unlike the context menu above — deliberately outside the chain — the
  // popover IS in the chain, because unlike a right-click menu it sits over surfaces whose own
  // Escape responses would otherwise win: a popover open over the fullscreen channel bar must
  // close before the bar swaps the channel underneath it.
  function openProgrammePopover(state: ProgrammePopoverState): void {
    setProgrammePopover(state)
    setProgrammeDetailOpen(true)
  }
  function closeProgrammePopover(): void {
    setProgrammePopover(null)
    setProgrammeDetailOpen(false)
  }
  // For the ref below and the unmount cleanup: a snapshot of the payload as of the last commit.
  useEffect(() => {
    programmePopoverRef.current = programmePopover
  }, [programmePopover])
  // Unmount drops the mirror only if THIS grid is the one holding an open popover: two grids can
  // be mounted at once (the docked panel and the fullscreen channel bar both render this
  // component), and one unmounting must not close the other's popover as far as Escape cares.
  useEffect(() => {
    return () => {
      if (programmePopoverRef.current !== null) setProgrammeDetailOpen(false)
    }
  }, [setProgrammeDetailOpen])
  // Escape closing the popover is decided centrally and never passes through this component's
  // setters — so watch the mirror flip off underneath a live payload and drop the payload with
  // it. Without this, the next click on the same block would read a stale payload, see "already
  // open", and play instead of (re)opening.
  useEffect(() => {
    if (!programmeDetailOpen && programmePopover !== null) setProgrammePopover(null)
  }, [programmeDetailOpen, programmePopover])

  // Closes the popover when the user clicks anywhere else — but NOT on a programme block: a
  // block's own click decides what happens (move the popover to that block; a second click on
  // the same one plays), and closing on mousedown would fire first and make every block click
  // look like a first click again. Buttons inside the popover keep it open so remind/record can
  // be toggled without dismissing the panel they belong to.
  useEffect(() => {
    if (!programmePopover) return
    function onDocMouseDown(e: MouseEvent): void {
      const target = e.target as HTMLElement | null
      if (target?.closest('.epg-programme-popover')) return
      if (target?.closest('.epg-block')) return
      // The same paired write closeProgrammePopover does — inlined because the helpers are
      // plain closures, and effect deps want the stable setters.
      setProgrammePopover(null)
      setProgrammeDetailOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [programmePopover, setProgrammeDetailOpen])

  // The same programme on the same channel — matched by the provider's programme id AND its
  // listed start time (the two fields the recording-schedule matcher uses), so a re-listed
  // programme with a shifted slot is a different popover, not a stray second click.
  function isPopoverForSameProgramme(channel: LiveStream, programme: ShortEpgProgram): boolean {
    return (
      programmePopover !== null &&
      programmePopover.channel.stream_id === channel.stream_id &&
      programmePopover.channel.playlistId === channel.playlistId &&
      programmePopover.programme.id === programme.id &&
      programmePopover.programme.start_timestamp === programme.start_timestamp
    )
  }

  // The watch action the block's click has always taken (lib/programmeDetail owns the rule: a
  // past programme on an archived channel plays from the start, everything else selects).
  function takeProgrammeAction(channel: LiveStream, programme: ShortEpgProgram): void {
    if (programmeWatchAction(programme, channel, now) === 'catchup') onWatchTimeshift(channel, programme)
    else onSelectChannel(channel)
  }

  // 0.45.0: a single click on a programme block OPENS (or moves) the detail popover instead of
  // acting right away; a second click on the same block takes the action. Playing closes the
  // popover either way — the click that follows playback must read as a fresh first click.
  function handleProgrammeBlockClick(
    channel: LiveStream,
    programme: ShortEpgProgram,
    rect: ProgrammePopoverState['rect']
  ): void {
    if (isPopoverForSameProgramme(channel, programme)) {
      closeProgrammePopover()
      takeProgrammeAction(channel, programme)
      return
    }
    openProgrammePopover({ channel, programme, rect })
  }

  function watchFromPopover(): void {
    if (!programmePopover) return
    const { channel, programme } = programmePopover
    closeProgrammePopover()
    takeProgrammeAction(channel, programme)
  }

  // The menu is 190px wide and two items tall (plus its title row) — clamped against the viewport
  // so a right-click near an edge still opens it fully on screen rather than half off it.
  function openChannelMenu(x: number, y: number, channel: LiveStream): void {
    const MENU_WIDTH = 200
    // The base menu is title + two items; each "Also on …" entry adds a row. Computing it here
    // keeps the edge-clamp honest for the menu that is actually about to render.
    const alsoOnCount = numericChannelCatalog
      ? Math.min(findAlsoOnCandidates(channel, numericChannelCatalog, primaryPlaylistId).length, MAX_ALSO_ON_ITEMS)
      : 0
    const MENU_HEIGHT = 110 + alsoOnCount * 34
    setContextMenu({
      channel,
      x: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8))
    })
  }

  function handleRowContextMenu(e: React.MouseEvent, channel: LiveStream): void {
    e.preventDefault()
    // Two popups at once is one too many — right-clicking (even on the block the popover is
    // open on) is a different gesture asking for a different panel, and the menu's own
    // outside-click rule would leave the popover stranded behind it.
    closeProgrammePopover()
    if (!numericChannelCatalog) void ensureChannelCatalog()
    openChannelMenu(e.clientX, e.clientY, channel)
  }

  function closeChannelMenu(refocusGrid = true): void {
    setContextMenu(null)
    // Focus returns to the grid so the arrow-key row navigation it already owns keeps working
    // after the menu closes (the menu itself took focus while it was open).
    if (refocusGrid) rootRef.current?.focus()
  }

  // Keeps the focused row in range as the channel list itself changes (a search filter
  // shrinking it, a different category loading in) rather than pointing past the end.
  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(0, channels.length - 1)))
  }, [channels.length])

  // Applied exactly once, the first time the list actually has rows to scroll — channels often
  // arrives empty on the initial render (still loading) and fills in moments later, so this
  // can't just run on mount; it has to wait for that fill-in and then never fire again, or every
  // later re-render with a nonzero channel count would keep re-snapping the list back here even
  // after the user has scrolled elsewhere themselves.
  //
  // The setTimeout is load-bearing, not a style choice: react-window's List mounts its
  // scrollable container as null on the very first render and only wires the real DOM element
  // into its imperative handle (the thing listRef.current.scrollToRow actually reads) on a
  // second, internal re-render right after. Calling scrollToRow from a plain useEffect races
  // that internal re-render and silently no-ops — confirmed live: the exact same call scrolled
  // correctly every time once deferred a tick, and never once when called synchronously.
  useEffect(() => {
    if (appliedInitialScroll.current) return
    if (initialScrollIndex === undefined || initialScrollIndex === 0 || channels.length === 0) return
    appliedInitialScroll.current = true
    const timer = setTimeout(() => {
      listRef.current?.scrollToRow({
        index: Math.min(initialScrollIndex, channels.length - 1),
        align: 'start',
        behavior: 'auto'
      })
    }, 50)
    return () => clearTimeout(timer)
  }, [channels.length, initialScrollIndex, listRef])

  const baseHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  const windowStart = baseHour + windowOffsetMs
  const windowEnd = windowStart + WINDOW_HOURS * HOUR_MS

  // Ticks sit at real clock-hour boundaries, not at fixed fractions of the window — that's
  // what makes them visually slide as windowStart shifts continuously (wheel-scrolling moves
  // it by 30s increments, so it's rarely hour-aligned). Anchoring ticks to windowStart itself
  // instead would always land them at the same 0/33/66/100% positions no matter how far you'd
  // scrolled, since pct() is relative to the window — only their label text would change,
  // making the header look stuck in place.
  const firstTick = Math.ceil(windowStart / HOUR_MS) * HOUR_MS
  const hourTicks: number[] = []
  for (let t = firstTick; t <= windowEnd; t += HOUR_MS) hourTicks.push(t)

  function handleWheel(e: React.WheelEvent): void {
    // The menu is anchored to a screen position, but the row it belongs to scrolls with the
    // grid — so any scroll over the grid (but not over the menu itself) closes it, which is the
    // behaviour every native context menu has. The popover is anchored the same way (numbers
    // captured at open time), so it closes for the same reason.
    if (contextMenu && !(e.target as HTMLElement).closest('.epg-context-menu')) setContextMenu(null)
    if (programmePopover && !(e.target as HTMLElement).closest('.epg-programme-popover')) closeProgrammePopover()
    // Horizontal trackpad swipe (deltaX) or a plain mouse wheel while holding Shift
    // (browsers report that as deltaX too) shifts the visible time window; a normal
    // vertical scroll is left alone so it can scroll the channel rows as usual.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()
    setWindowOffsetMs((o) =>
      Math.min(MAX_WINDOW_OFFSET_MS, Math.max(-MAX_WINDOW_OFFSET_MS, o + e.deltaX * (MS_PER_SCROLL_UNIT / 100)))
    )
  }

  // Click-and-drag panning of the time axis — grabbing anywhere on the timeline (a programme
  // block, the header ticks, empty space) and moving left/right shifts windowOffsetMs 1:1 with
  // the cursor, the same "content follows your mouse" feel as panning a map, rather than the
  // wheel handler's arbitrary per-notch increment above. Scoped to the timeline region only (via
  // the clientX check against channelColumnWidth) — the channel-name column isn't part of the
  // time axis, and dragging a channel name is more naturally left alone.
  function handleTimelineMouseDown(e: React.MouseEvent): void {
    if (e.button !== 0) return
    // The column-resize handle already runs its own drag (useResizableWidth's startDrag) and
    // doesn't stopPropagation — without this check, grabbing it would also start a time-pan
    // drag at the same time, fighting over the same mousemove/mouseup listeners.
    if ((e.target as HTMLElement).closest('.resize-handle')) return
    // The context menu floats over the timeline, so a click on one of its items would otherwise
    // also start (and immediately finish) a time-pan drag underneath it. The programme-detail
    // popover floats the same way.
    if ((e.target as HTMLElement).closest('.epg-context-menu')) return
    if ((e.target as HTMLElement).closest('.epg-programme-popover')) return
    const container = rootRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (e.clientX - rect.left < channelColumnWidth) return
    const trackWidth = rect.width - channelColumnWidth
    if (trackWidth <= 0) return
    // Native text/drag-image selection over channel names or programme titles would otherwise
    // kick in the moment the mouse moves, visually fighting this drag.
    e.preventDefault()

    const startX = e.clientX
    const startOffset = windowOffsetMs
    const msPerPixel = (WINDOW_HOURS * HOUR_MS) / trackWidth
    let moved = false

    function onMouseMove(ev: MouseEvent): void {
      const deltaX = ev.clientX - startX
      if (Math.abs(deltaX) > DRAG_CLICK_THRESHOLD_PX) moved = true
      setWindowOffsetMs(Math.min(MAX_WINDOW_OFFSET_MS, Math.max(-MAX_WINDOW_OFFSET_MS, startOffset - deltaX * msPerPixel)))
    }
    // A real drag ending on a channel-select button or programme block would otherwise still
    // fire that element's own click right after mouseup, immediately undoing the "just panning,
    // not selecting" intent a mouse-move-based drag implies. The removal is a defensive fallback
    // for the (effectively never, but not impossible) case where mouseup isn't followed by a
    // click at all — click dispatches synchronously right after mouseup for a real drag, so this
    // scheduled cleanup only ever runs after that, never before it.
    function suppressNextClick(ev: MouseEvent): void {
      ev.stopPropagation()
      ev.preventDefault()
    }
    function onMouseUp(): void {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (moved) {
        // A real drag panned the timeline out from under any open popover's captured anchor —
        // close it (the same reasoning as the wheel close above) rather than leave it floating
        // where its block used to be. (A mousedown that lands on a block doesn't close it — the
        // block's own click decides — so this is the one drag path that can strand it.)
        closeProgrammePopover()
        window.addEventListener('click', suppressNextClick, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', suppressNextClick, { capture: true }), 0)
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  // Scoped to this element (via tabIndex, not a document-level listener) specifically because
  // the main grid and the fullscreen channel bar can both be mounted at once — a global
  // listener would move both grids' selections on every arrow press instead of just the
  // visible/focused one.
  function handleKeyDown(e: React.KeyboardEvent): void {
    if (channels.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.min(channels.length - 1, focusedIndex + 1)
      setFocusedIndex(next)
      listRef.current?.scrollToRow({ index: next, align: 'smart' })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(0, focusedIndex - 1)
      setFocusedIndex(next)
      listRef.current?.scrollToRow({ index: next, align: 'smart' })
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      // A screenful, measured at press time from this grid's own height rather than assumed: the
      // grid is resize-draggable and mounts at two very different heights (docked panel vs the
      // fullscreen channel bar), so a fixed row count would overshoot one and undershoot the
      // other. One row is subtracted so a page always overlaps the previous view slightly.
      const pageRows = Math.max(1, Math.floor((rootRef.current?.clientHeight ?? 400) / rowHeight) - 1)
      const delta = e.key === 'PageDown' ? pageRows : -pageRows
      const next = Math.max(0, Math.min(channels.length - 1, focusedIndex + delta))
      setFocusedIndex(next)
      listRef.current?.scrollToRow({ index: next, align: 'smart' })
    } else if (e.key === 'Enter') {
      // Enter inside the popover belongs to the popover's own focused button — buttons fire
      // click on Enter keydown, so letting the event bubble here as well would select the
      // grid's focused row on top of whatever the button just did. (Escape needs no such guard:
      // this handler has no Escape branch, and the key travels to the central chain, which
      // closes the popover.)
      if ((e.target as HTMLElement).closest('.epg-programme-popover')) return
      e.preventDefault()
      const channel = channels[focusedIndex]
      if (channel) onSelectChannel(channel)
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      // Keyboard equivalent of right-click, anchored to the focused row rather than a cursor.
      e.preventDefault()
      const channel = channels[focusedIndex]
      if (!channel) return
      const rowChannel = rootRef.current?.querySelector('.epg-row--focused .epg-row-channel')
      const rect = rowChannel?.getBoundingClientRect()
      openChannelMenu(rect ? rect.left + 32 : 32, rect ? rect.bottom : 64, channel)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`epg-grid${compact ? ' epg-grid--compact' : ''}`}
      tabIndex={0}
      onWheel={handleWheel}
      onMouseDown={handleTimelineMouseDown}
      onKeyDown={handleKeyDown}
      style={{ '--epg-channel-col-width': `${channelColumnWidth}px` } as CSSProperties}
    >
      {/* Spans the header and every row at once (rather than a per-row handle) since they all
          share this one width — dragging from any point along the column boundary resizes all
          of them together. Positioned like Sidebar's own resize-handle--right, just with a
          dynamic offset instead of a fixed one since this column's width isn't a static CSS
          value. */}
      <div
        className="resize-handle"
        style={{ left: channelColumnWidth - 4 }}
        onMouseDown={startChannelColumnDrag}
        title="Drag to resize the channel column"
      />
      <div className="epg-time-header">
        <div className="epg-grid-nav">
          <button onClick={() => setWindowOffsetMs((o) => Math.max(-MAX_WINDOW_OFFSET_MS, o - HOUR_MS))} title="Earlier">
            ◀
          </button>
          <button onClick={() => setWindowOffsetMs(0)} title="Jump to now">
            Now
          </button>
          <button onClick={() => setWindowOffsetMs((o) => Math.min(MAX_WINDOW_OFFSET_MS, o + HOUR_MS))} title="Later">
            ▶
          </button>
        </div>
        <div className="epg-time-header-track">
          {hourTicks.map((t) => (
            <span key={t} className="epg-time-tick" style={{ left: `${pct(t, windowStart, windowEnd)}%` }}>
              {formatHour(t, clockFormat)}
            </span>
          ))}
        </div>
        {extraNavControls && <div className="epg-time-header-controls">{extraNavControls}</div>}
      </div>
      <div className="epg-grid-body">
        {channels.length === 0 ? (
          <p className="modal-loading">No channels to show.</p>
        ) : (
          <List<RowProps>
            listRef={listRef}
            rowCount={channels.length}
            rowHeight={rowHeight}
            rowProps={{
              channels,
              windowStart,
              windowEnd,
              now,
              activeStreamId,
              focusedIndex,
              clockFormat,
              onSelectChannel,
              onWatchFullscreen,
              onProgrammeBlockClick: handleProgrammeBlockClick,
              isVideoFailed,
              onChannelContextMenu: handleRowContextMenu
            }}
            rowComponent={EpgRow}
            style={{ height: '100%', width: '100%' }}
          />
        )}
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="epg-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Handled here, and stopped from reaching App.tsx's document-level chain, because
              // this menu isn't part of that chain — see the outside-click effect above.
              e.stopPropagation()
              closeChannelMenu()
            }
          }}
        >
          <span className="epg-context-menu-title" title={contextMenu.channel.name}>
            {contextMenu.channel.name}
          </span>
          <button
            role="menuitem"
            onClick={() => {
              toggleHiddenLiveChannel(contextMenu.channel.stream_id, contextMenu.channel.playlistId)
              closeChannelMenu()
            }}
          >
            {isChannelHidden(contextMenu.channel.playlistId, contextMenu.channel.stream_id)
              ? 'Show channel'
              : 'Hide channel'}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const channel = contextMenu.channel
              // No refocus: the guide's own modal takes over from here.
              closeChannelMenu(false)
              void (async () => {
                // True OS fullscreen paints only the fullscreened element and its descendants
                // (see App.tsx's onOpenAbout), so opening this from the fullscreen channel bar
                // means leaving fullscreen first or the modal would render invisibly behind it.
                if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
                openEpgMatch(channel.stream_id, channel.name, channel.playlistId)
              })()
            }}
          >
            EPG match…
          </button>
          {(numericChannelCatalog
            ? findAlsoOnCandidates(contextMenu.channel, numericChannelCatalog, primaryPlaylistId)
            : []
          )
            .slice(0, MAX_ALSO_ON_ITEMS)
            .map((candidate: AlsoOnCandidate) => (
              <button
                key={`also-on-${candidate.playlistId}`}
                role="menuitem"
                title={`Switch to this channel on the "${candidate.playlistName}" playlist`}
                onClick={() => {
                  closeChannelMenu()
                  playChannel('live', candidate.streamId, candidate.name, 'm3u8', candidate.icon, candidate.tvArchive, candidate.playlistId)
                }}
              >
                Also on {candidate.playlistName} →
              </button>
            ))}
        </div>
      )}
      {programmePopover &&
        (() => {
          // Content shaping lives in lib/programmeDetail (pure, unit-tested) — the rule for what
          // the button offers is exactly the block click's old catch-up rule.
          const { channel, programme, rect } = programmePopover
          const detail = buildProgrammeDetail(programme, channel, now, clockFormat)
          const popoverChannelId = channelKey(channel.playlistId, channel.stream_id, primaryPlaylistId)
          const popoverReminderSet = isEpgReminderSet(channel.stream_id, programme.id, channel.playlistId)
          const popoverRecording = scheduledRecordingOf(popoverChannelId, programme, recordings)
          const position = placePopover(rect, window.innerWidth, window.innerHeight)
          return (
            // position:fixed at the captured viewport anchor — the same arrangement the context
            // menu uses, and for the same reason: the row that opened this is virtualized and may
            // be gone (or recycled) by the time this paints. Escape is handled by the central
            // chain (lib/overlays.ts), not here — the popover renders with no focused element of
            // its own, so the grid keeps its arrow-key navigation while it is open.
            <div
              className="epg-programme-popover"
              style={{ left: position.left, top: position.top }}
              role="dialog"
              aria-label={`${programme.title} on ${channel.name}`}
            >
              <span className="epg-programme-popover-channel" title={channel.name}>
                {channel.name}
              </span>
              <h3 className="epg-programme-popover-title" title={programme.title}>
                {programme.title}
              </h3>
              <span className="epg-programme-popover-time">{detail.timeRange}</span>
              <p className="epg-programme-popover-desc">{detail.description ?? NO_DESCRIPTION_LABEL}</p>
              <div className="epg-programme-popover-actions">
                <button
                  className="epg-programme-popover-watch"
                  title={
                    detail.watchAction === 'catchup'
                      ? `Play ${programme.title} from its start (catch-up)`
                      : `Select ${channel.name}`
                  }
                  onClick={watchFromPopover}
                >
                  ▶ {detail.watchLabel}
                </button>
                {detail.isUpcoming && (
                  <button
                    className={`epg-programme-popover-action${popoverReminderSet ? ' epg-programme-popover-action--set' : ''}`}
                    title={popoverReminderSet ? 'Remove programme reminder' : 'Set programme reminder'}
                    aria-label={
                      popoverReminderSet ? `Remove reminder for ${programme.title}` : `Set reminder for ${programme.title}`
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleEpgReminder(channel.stream_id, channel.name, programme, channel.playlistId)
                    }}
                  >
                    {popoverReminderSet ? '🔔' : '🔕'}
                  </button>
                )}
                {detail.isUpcoming && (
                  <button
                    className={`epg-programme-popover-action${popoverRecording ? ' epg-programme-popover-action--set' : ''}`}
                    title={
                      popoverRecording
                        ? `Cancel scheduled recording of ${programme.title}`
                        : `Record ${programme.title} (starts ${formatStartLabel(programme.start_timestamp, clockFormat)})`
                    }
                    aria-label={
                      popoverRecording ? `Cancel recording of ${programme.title}` : `Record ${programme.title}`
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      if (popoverRecording) void cancelScheduledRecording(popoverRecording.id)
                      else void scheduleRecording(channel, programme)
                    }}
                  >
                    {popoverRecording ? '⏹' : '⏺'}
                  </button>
                )}
              </div>
            </div>
          )
        })()}
    </div>
  )
}
