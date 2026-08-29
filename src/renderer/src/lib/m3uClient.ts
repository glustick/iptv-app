import { parseM3u, type M3uChannel } from './m3u'
import { parseXmltv, type EpgData } from './epg'
import type { IptvClient } from './iptvClient'
import type {
  XtreamAuthResponse,
  Category,
  LiveStream,
  VodStream,
  SeriesItem,
  SeriesInfo,
  ShortEpgProgram,
  MediaKind
} from './types'

const UNCATEGORIZED = 'Uncategorized'

/**
 * Implements the same IptvClient surface as XtreamClient for providers that only hand out a
 * bare M3U playlist (plus, usually, a separate EPG XML URL) instead of full Xtream Codes
 * credentials. Deliberately live-TV-only: a flat M3U has no structured movie/series catalog the
 * way Xtream's API does, so getVodCategories/getVodStreams/getSeries* all return empty rather
 * than guessing content type from channel names or group titles.
 *
 * Every request (the playlist itself, the EPG XML, and every channel's own stream URL) is
 * routed through the local proxy's /__fetch/ passthrough rather than fetched directly — unlike
 * Xtream, where every request shares one base URL the proxy can resolve paths against, an M3U
 * playlist can reference a completely different host per channel, and Chromium blocks all of it
 * as cross-origin the same way it blocks Xtream's own API (see proxyServer.ts).
 */
export class M3uClient implements IptvClient {
  private readonly proxyBase: string
  private readonly m3uUrl: string
  private readonly explicitEpgUrl: string | null
  private channelsById: Map<number, M3uChannel> = new Map()
  private discoveredEpgUrl: string | null = null
  private epgData: EpgData | null = null
  private epgFetch: Promise<EpgData | null> | null = null

  constructor(proxyBase: string, m3uUrl: string, epgUrl: string | null) {
    this.proxyBase = proxyBase.replace(/\/+$/, '')
    this.m3uUrl = m3uUrl
    this.explicitEpgUrl = epgUrl
  }

  private proxied(url: string): string {
    return `${this.proxyBase}/__fetch/${encodeURIComponent(url)}`
  }

  private async fetchText(url: string, label: string): Promise<string> {
    const res = await fetch(this.proxied(url))
    if (!res.ok) {
      throw new Error(`${label} request failed: ${res.status} ${res.statusText}`)
    }
    return res.text()
  }

  /** Live TV only — see the class doc comment for why there's no VOD/series equivalent here. */
  async authenticate(): Promise<XtreamAuthResponse> {
    const text = await this.fetchText(this.m3uUrl, 'M3U playlist')
    const { channels, epgUrl } = parseM3u(text)
    if (channels.length === 0) {
      throw new Error('No channels found in this M3U playlist')
    }
    this.discoveredEpgUrl = epgUrl
    this.channelsById = new Map(channels.map((channel, index) => [index + 1, channel]))
    return {
      user_info: {
        username: '',
        password: '',
        status: 'Active',
        exp_date: null,
        is_trial: '0',
        active_cons: '0',
        created_at: '',
        // '0' (not '1') deliberately — an M3U playlist carries no connection-limit information
        // at all, and singleConnectionAccount's whole point is warning about a *known* single-
        // connection cap, not an unknown one. Assuming the more permissive case by default is
        // the safer failure mode here (a missed warning vs. one shown for no reason).
        max_connections: '0'
      },
      server_info: { url: '', port: '', https_port: '', server_protocol: '', timezone: '' }
    }
  }

  private allChannels(): Array<{ id: number; channel: M3uChannel }> {
    return [...this.channelsById.entries()].map(([id, channel]) => ({ id, channel }))
  }

  private categoryIdFor(channel: M3uChannel): string {
    return channel.groupTitle || UNCATEGORIZED
  }

  async getLiveCategories(): Promise<Category[]> {
    const seen = new Set<string>()
    const categories: Category[] = []
    for (const { channel } of this.allChannels()) {
      const id = this.categoryIdFor(channel)
      if (seen.has(id)) continue
      seen.add(id)
      categories.push({ category_id: id, category_name: id, parent_id: 0 })
    }
    return categories
  }

  async getLiveStreams(categoryId?: string): Promise<LiveStream[]> {
    return this.allChannels()
      .filter(({ channel }) => !categoryId || this.categoryIdFor(channel) === categoryId)
      .map(({ id, channel }, index) => ({
        num: index + 1,
        name: channel.name,
        stream_type: 'live',
        stream_id: id,
        stream_icon: channel.tvgLogo ?? '',
        epg_channel_id: channel.tvgId,
        added: '',
        category_id: this.categoryIdFor(channel),
        custom_sid: null,
        // M3U carries no catch-up/DVR convention this app could rely on.
        tv_archive: 0,
        direct_source: channel.url,
        tv_archive_duration: 0
      }))
  }

  async getVodCategories(): Promise<Category[]> {
    return []
  }

  async getVodStreams(): Promise<VodStream[]> {
    return []
  }

  async getSeriesCategories(): Promise<Category[]> {
    return []
  }

  async getSeries(): Promise<SeriesItem[]> {
    return []
  }

  async getSeriesInfo(_seriesId: number): Promise<SeriesInfo> {
    throw new Error('This connection has no series catalog (M3U playlists are live-TV only)')
  }

  // Lazily fetched once per session, not per channel — the only EPG source available here is
  // one full XMLTV document covering every channel, unlike Xtream's genuinely per-channel
  // get_short_epg endpoint. Cached (not refetched on every call) since EpgGrid's rows call this
  // once per visible channel as they scroll into view.
  private async ensureEpgData(): Promise<EpgData | null> {
    const epgUrl = this.explicitEpgUrl || this.discoveredEpgUrl
    if (!epgUrl) return null
    if (this.epgData) return this.epgData
    if (!this.epgFetch) {
      this.epgFetch = this.fetchText(epgUrl, 'EPG')
        .then((xml) => {
          this.epgData = parseXmltv(xml)
          return this.epgData
        })
        .catch(() => null)
    }
    return this.epgFetch
  }

  async getShortEpg(streamId: number, limit = 10): Promise<ShortEpgProgram[]> {
    const channel = this.channelsById.get(streamId)
    if (!channel?.tvgId) return []
    const epgData = await this.ensureEpgData()
    const programmes = epgData?.programmesByChannel.get(channel.tvgId)
    if (!programmes) return []
    const now = new Date()
    // get_short_epg's own contract is "now plus whatever's next," not the channel's entire
    // guide — mirrored here so EpgGrid's window-based filtering behaves identically regardless
    // of which client actually supplied the data.
    return programmes
      .filter((p) => p.stop >= now)
      .slice(0, limit)
      .map((p, index) => ({
        id: `${streamId}-${index}`,
        epg_id: channel.tvgId ?? '',
        title: p.title,
        lang: '',
        start: p.start.toISOString(),
        end: p.stop.toISOString(),
        description: p.description ?? '',
        channel_id: channel.tvgId ?? '',
        start_timestamp: String(Math.floor(p.start.getTime() / 1000)),
        stop_timestamp: String(Math.floor(p.stop.getTime() / 1000))
      }))
  }

  /**
   * Unlike getShortEpg (used per-channel by the EPG grid), nothing in this app currently calls
   * this — kept for IptvClient parity with XtreamClient rather than because it's exercised.
   */
  async getFullEpgXml(): Promise<string> {
    const epgUrl = this.explicitEpgUrl || this.discoveredEpgUrl
    if (!epgUrl) throw new Error('No EPG URL configured for this playlist')
    return this.fetchText(epgUrl, 'EPG')
  }

  // _extension is part of IptvClient's shape (Xtream needs it to build a .../id.ext URL) but
  // unused here — an M3U entry's own URL already carries whatever extension it needs.
  getStreamUrl(kind: MediaKind, streamId: number, _extension: string): string {
    if (kind !== 'live') {
      throw new Error('This connection has no VOD/series catalog (M3U playlists are live-TV only)')
    }
    const channel = this.channelsById.get(streamId)
    if (!channel) throw new Error(`Unknown channel: ${streamId}`)
    return this.proxied(channel.url)
  }

  getTimeshiftUrl(_streamId: number, _start: Date, _durationMinutes: number, _extension?: string): string {
    throw new Error('Catch-up is not supported for M3U playlists')
  }
}
