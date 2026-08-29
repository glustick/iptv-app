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
import type { IptvClient } from './iptvClient'

function decodeBase64Maybe(value: string | undefined | null): string {
  if (!value) return ''
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return value
  }
}

export class XtreamClient implements IptvClient {
  private readonly baseUrl: string
  private readonly username: string
  private readonly password: string

  constructor(server: string, username: string, password: string) {
    this.baseUrl = server.trim().replace(/\/+$/, '')
    this.username = username
    this.password = password
  }

  private playerApiUrl(params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}/player_api.php`)
    url.searchParams.set('username', this.username)
    url.searchParams.set('password', this.password)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    return url.toString()
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Xtream request failed: ${res.status} ${res.statusText}`)
    }
    return res.json() as Promise<T>
  }

  async authenticate(): Promise<XtreamAuthResponse> {
    const result = await this.getJson<XtreamAuthResponse>(this.playerApiUrl())
    if (!result?.user_info || result.user_info.auth === 0) {
      throw new Error('Invalid Xtream credentials')
    }
    return result
  }

  async getLiveCategories(): Promise<Category[]> {
    return this.getJson<Category[]>(this.playerApiUrl({ action: 'get_live_categories' }))
  }

  async getLiveStreams(categoryId?: string): Promise<LiveStream[]> {
    const params: Record<string, string> = { action: 'get_live_streams' }
    if (categoryId) params.category_id = categoryId
    return this.getJson<LiveStream[]>(this.playerApiUrl(params))
  }

  async getVodCategories(): Promise<Category[]> {
    return this.getJson<Category[]>(this.playerApiUrl({ action: 'get_vod_categories' }))
  }

  async getVodStreams(categoryId?: string): Promise<VodStream[]> {
    const params: Record<string, string> = { action: 'get_vod_streams' }
    if (categoryId) params.category_id = categoryId
    return this.getJson<VodStream[]>(this.playerApiUrl(params))
  }

  async getSeriesCategories(): Promise<Category[]> {
    return this.getJson<Category[]>(this.playerApiUrl({ action: 'get_series_categories' }))
  }

  async getSeries(categoryId?: string): Promise<SeriesItem[]> {
    const params: Record<string, string> = { action: 'get_series' }
    if (categoryId) params.category_id = categoryId
    return this.getJson<SeriesItem[]>(this.playerApiUrl(params))
  }

  async getSeriesInfo(seriesId: number): Promise<SeriesInfo> {
    return this.getJson<SeriesInfo>(
      this.playerApiUrl({ action: 'get_series_info', series_id: String(seriesId) })
    )
  }

  async getShortEpg(streamId: number, limit = 10): Promise<ShortEpgProgram[]> {
    const result = await this.getJson<{ epg_listings: ShortEpgProgram[] }>(
      this.playerApiUrl({ action: 'get_short_epg', stream_id: String(streamId), limit: String(limit) })
    )
    const listings = result?.epg_listings ?? []
    return listings.map((item) => ({
      ...item,
      title: decodeBase64Maybe(item.title),
      description: decodeBase64Maybe(item.description)
    }))
  }

  /** Full XMLTV guide covering every channel on the account, for the multi-channel EPG grid. */
  async getFullEpgXml(): Promise<string> {
    const url = new URL(`${this.baseUrl}/xmltv.php`)
    url.searchParams.set('username', this.username)
    url.searchParams.set('password', this.password)
    const res = await fetch(url.toString())
    if (!res.ok) {
      throw new Error(`EPG request failed: ${res.status} ${res.statusText}`)
    }
    return res.text()
  }

  getStreamUrl(kind: MediaKind, streamId: number, extension: string): string {
    const path = kind === 'live' ? 'live' : kind === 'movie' ? 'movie' : 'series'
    return `${this.baseUrl}/${path}/${this.username}/${this.password}/${streamId}.${extension}`
  }

  /**
   * Catch-up/DVR playback for channels with `tv_archive` enabled, per the Xtream Codes
   * timeshift convention: /timeshift/{user}/{pass}/{duration in minutes}/{start "YYYY-MM-DD:HH-MM"}/{stream_id}.{ext}
   */
  getTimeshiftUrl(streamId: number, start: Date, durationMinutes: number, extension = 'm3u8'): string {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const startToken = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}:${pad(start.getHours())}-${pad(start.getMinutes())}`
    return `${this.baseUrl}/timeshift/${this.username}/${this.password}/${Math.max(1, Math.round(durationMinutes))}/${startToken}/${streamId}.${extension}`
  }
}
