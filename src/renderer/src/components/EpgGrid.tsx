import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { List, useListRef } from 'react-window'
import { useAppStore } from '../store/useAppStore'
import { useResizableWidth } from '../lib/useResizableWidth'
import { pct } from '../lib/epgTime'
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
  onWatchTimeshift: (channel: LiveStream, program: ShortEpgProgram) => void
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
  onWatchFullscreen,
  onWatchTimeshift
}: { index: number; style: CSSProperties } & RowProps): JSX.Element {
  const channel = channels[index]
  const shortEpgByStream = useAppStore((s) => s.shortEpgByStream)
  const loadShortEpg = useAppStore((s) => s.loadShortEpg)

  // Rows are virtualized, so this only fires for channels actually scrolled into view —
  // fine even against a 24k-channel catalog. This is also the workaround for providers
  // that block the full multi-channel xmltv.php guide (this app's own test account 403s
  // on it): get_short_epg is per-channel and part of the core Xtream API instead.
  useEffect(() => {
    // loadShortEpg catches its own errors internally (EPG is best-effort) and always resolves.
    void loadShortEpg(channel.stream_id)
  }, [channel.stream_id, loadShortEpg])

  const listings = shortEpgByStream[channel.stream_id]
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
      title={`${channel.name} (double-click for fullscreen)`}
    >
      <button className="epg-row-channel" onClick={() => onSelectChannel(channel)}>
        {channel.stream_icon ? (
          <img src={channel.stream_icon} alt="" loading="lazy" />
        ) : (
          <span className="epg-row-channel-icon placeholder" />
        )}
        <span className="epg-row-channel-name">{channel.name}</span>
      </button>
      <div className="epg-row-timeline">
        {listings === undefined && <div className="epg-row-loading" />}
        {visible.map((p, i) => {
          const startMs = Number(p.start_timestamp) * 1000
          const stopMs = Number(p.stop_timestamp) * 1000
          const left = pct(startMs, windowStart, windowEnd)
          const width = Math.max(pct(stopMs, windowStart, windowEnd) - left, 2)
          const isPast = stopMs <= now
          const canCatchUp = isPast && channel.tv_archive === 1
          return (
            <button
              key={`${p.id}-${i}`}
              className={`epg-block${isPast ? ' epg-block--past' : ''}${canCatchUp ? ' epg-block--catchup' : ''}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${formatTime(p.start_timestamp, clockFormat)} – ${formatTime(p.stop_timestamp, clockFormat)}\n${p.title}${p.description ? '\n' + p.description : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                if (canCatchUp) onWatchTimeshift(channel, p)
                else onSelectChannel(channel)
              }}
            >
              <span className="epg-block-label">{p.title}</span>
            </button>
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
  onSelectChannel: (channel: LiveStream) => void
  onWatchFullscreen: (channel: LiveStream) => void
  onWatchTimeshift: (channel: LiveStream, program: ShortEpgProgram) => void
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
  onSelectChannel,
  onWatchFullscreen,
  onWatchTimeshift
}: EpgGridProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [windowOffsetMs, setWindowOffsetMs] = useState(0)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const listRef = useListRef(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Shared by the main docked guide and the fullscreen channel-swap overlay (both render this
  // same component) — persisted so a name that was clipped once stays legible everywhere this
  // grid shows up, not just in whichever context it was resized from.
  const epgChannelColumnWidth = useAppStore((s) => s.settings.epgChannelColumnWidth)
  const updateSettings = useAppStore((s) => s.updateSettings)
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

  // Keeps the focused row in range as the channel list itself changes (a search filter
  // shrinking it, a different category loading in) rather than pointing past the end.
  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(0, channels.length - 1)))
  }, [channels.length])

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
    // Horizontal trackpad swipe (deltaX) or a plain mouse wheel while holding Shift
    // (browsers report that as deltaX too) shifts the visible time window; a normal
    // vertical scroll is left alone so it can scroll the channel rows as usual.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()
    setWindowOffsetMs((o) =>
      Math.min(MAX_WINDOW_OFFSET_MS, Math.max(-MAX_WINDOW_OFFSET_MS, o + e.deltaX * (MS_PER_SCROLL_UNIT / 100)))
    )
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
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const channel = channels[focusedIndex]
      if (channel) onSelectChannel(channel)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`epg-grid${compact ? ' epg-grid--compact' : ''}`}
      tabIndex={0}
      onWheel={handleWheel}
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
              onWatchTimeshift
            }}
            rowComponent={EpgRow}
            style={{ height: '100%', width: '100%' }}
          />
        )}
      </div>
    </div>
  )
}
