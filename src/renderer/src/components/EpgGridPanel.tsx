import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { List } from 'react-window'
import { useAppStore } from '../store/useAppStore'
import { useHlsAttach } from '../lib/useHlsAttach'
import { useResizableWidth } from '../lib/useResizableWidth'
import { useDebouncedValue } from '../lib/useDebouncedValue'
import type { LiveStream, ShortEpgProgram, ClockFormat } from '../lib/types'

const ROW_HEIGHT = 40
const WINDOW_HOURS = 3
const HOUR_MS = 3_600_000

function pct(t: number, start: number, end: number): number {
  if (end <= start) return 0
  return Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100))
}

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
  clockFormat: ClockFormat
  onSelectChannel: (channel: LiveStream) => void
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
  clockFormat,
  onSelectChannel,
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
    loadShortEpg(channel.stream_id)
  }, [channel.stream_id, loadShortEpg])

  const listings = shortEpgByStream[channel.stream_id]
  const visible = (listings ?? []).filter(
    (p) => Number(p.stop_timestamp) * 1000 > windowStart && Number(p.start_timestamp) * 1000 < windowEnd
  )
  const isActive = activeStreamId === channel.stream_id
  const nowPct = pct(now, windowStart, windowEnd)
  const showNowLine = now >= windowStart && now <= windowEnd

  return (
    <div style={style} className={isActive ? 'epg-row active' : 'epg-row'}>
      <button className="epg-row-channel" onClick={() => onSelectChannel(channel)} title={channel.name}>
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

// A multi-channel EPG guide, Gantt-chart style: channels run down the vertical axis, time
// runs left-to-right along the horizontal axis, and each programme is a positioned block
// sized by its duration. Replaces the old single-channel vertical preview — the small live
// video preview now lives in the top-left corner instead of taking the whole panel.
export function EpgGridPanel(): JSX.Element | null {
  const previewChannel = useAppStore((s) => s.previewChannel)
  const liveStreams = useAppStore((s) => s.liveStreams)
  const searchTerm = useAppStore((s) => s.searchTerm)
  const closeChannelPreview = useAppStore((s) => s.closeChannelPreview)
  const client = useAppStore((s) => s.client)
  const play = useAppStore((s) => s.play)
  const playTimeshift = useAppStore((s) => s.playTimeshift)
  const clockFormat = useAppStore((s) => s.settings.clockFormat)
  const isFavorited = useAppStore((s) => s.isFavorited)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const detailPanelWidth = useAppStore((s) => s.settings.detailPanelWidth)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openChannelPreview = useAppStore((s) => s.openChannelPreview)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [muted, setMuted] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [windowOffsetMs, setWindowOffsetMs] = useState(0)

  // Handle is on the panel's left edge (it's anchored to the right of the layout), so
  // dragging left should grow it — hence direction: -1. Wider bounds than the old
  // single-channel preview since a multi-channel grid genuinely benefits from more room.
  const { width, startDrag } = useResizableWidth(detailPanelWidth, -1, {
    min: 340,
    max: 1000,
    onCommit: (w) => updateSettings({ detailPanelWidth: w })
  })

  const debouncedSearch = useDebouncedValue(searchTerm, 150)
  const channels = useMemo(() => {
    if (!debouncedSearch.trim()) return liveStreams
    const needle = debouncedSearch.toLowerCase()
    return liveStreams.filter((c) => c.name.toLowerCase().includes(needle))
  }, [liveStreams, debouncedSearch])

  const previewUrl = useMemo(
    () => (client && previewChannel ? client.getStreamUrl('live', previewChannel.stream_id, 'm3u8') : null),
    [client, previewChannel]
  )
  useHlsAttach(videoRef, previewUrl, muted)

  useEffect(() => {
    if (!previewChannel) return
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [previewChannel])

  useEffect(() => {
    setMuted(true)
  }, [previewChannel?.stream_id])

  if (!previewChannel) return null

  const baseHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  const windowStart = baseHour + windowOffsetMs
  const windowEnd = windowStart + WINDOW_HOURS * HOUR_MS

  const hourTicks: number[] = []
  for (let t = windowStart; t <= windowEnd; t += HOUR_MS) hourTicks.push(t)

  const favorited = isFavorited('live', previewChannel.stream_id)

  function watchFullscreen(): void {
    if (!previewChannel) return
    // Closing the preview stops its own stream connection before the fullscreen player
    // opens its own — most Xtream accounts cap concurrent connections quite low (often
    // just 1), so two simultaneous streams to the same account can fail outright.
    play('live', previewChannel.stream_id, previewChannel.name, 'm3u8', previewChannel.stream_icon)
    closeChannelPreview()
  }

  function watchFromStart(channel: LiveStream, program: ShortEpgProgram): void {
    playTimeshift(channel, program)
    closeChannelPreview()
  }

  return (
    // The resize handle lives in this non-scrolling wrapper, not inside the scrollable
    // content div — see Sidebar.tsx for why (a position:absolute child of a scrolled
    // overflow:auto element scrolls with it).
    <aside className="channel-detail-panel" style={{ width }}>
      <div className="resize-handle resize-handle--left" onMouseDown={startDrag} />
      <div className="detail-panel-scroll">
        <div className="epg-panel-top">
          <div
            className="epg-preview-video-wrap"
            onClick={() => setMuted((m) => !m)}
            title={muted ? 'Click to unmute' : 'Click to mute'}
          >
            <video ref={videoRef} className="epg-preview-video" autoPlay playsInline />
            <span className="detail-preview-mute-badge">{muted ? '🔇' : '🔊'}</span>
          </div>
          <div className="epg-panel-top-info">
            <div className="epg-panel-top-heading">
              <h2>{previewChannel.name}</h2>
              <button
                className={favorited ? 'favorite-toggle active' : 'favorite-toggle'}
                onClick={() => toggleFavorite({ kind: 'live', stream: previewChannel })}
                title={favorited ? 'Remove from favorites' : 'Add to favorites'}
              >
                {favorited ? '★' : '☆'}
              </button>
              <button className="modal-close" onClick={closeChannelPreview} title="Close panel">
                ✕
              </button>
            </div>
            <button className="watch-now-button watch-now-button--compact" onClick={watchFullscreen}>
              ⛶ Watch fullscreen
            </button>
          </div>
        </div>

        <div className="epg-grid">
          <div className="epg-time-header">
            <div className="epg-grid-nav">
              <button onClick={() => setWindowOffsetMs((o) => o - HOUR_MS)} title="Earlier">
                ◀
              </button>
              <button onClick={() => setWindowOffsetMs(0)} title="Jump to now">
                Now
              </button>
              <button onClick={() => setWindowOffsetMs((o) => o + HOUR_MS)} title="Later">
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
          </div>
          <div className="epg-grid-body">
            {channels.length === 0 ? (
              <p className="modal-loading">No channels to show.</p>
            ) : (
              <List<RowProps>
                rowCount={channels.length}
                rowHeight={ROW_HEIGHT}
                rowProps={{
                  channels,
                  windowStart,
                  windowEnd,
                  now,
                  activeStreamId: previewChannel.stream_id,
                  clockFormat,
                  onSelectChannel: openChannelPreview,
                  onWatchTimeshift: watchFromStart
                }}
                rowComponent={EpgRow}
                style={{ height: '100%', width: '100%' }}
              />
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
