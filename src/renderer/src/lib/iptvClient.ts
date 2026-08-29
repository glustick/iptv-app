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

/**
 * The exact surface useAppStore.ts calls on `client` — implemented by both XtreamClient and
 * M3uClient so the store, EPG grid, player, etc. never need to know which backend a given
 * profile actually came from. authenticate()'s return shape is Xtream's own (user_info/
 * server_info) rather than something more generic purely because it's already what the store
 * reads singleConnectionAccount from; M3uClient synthesizes a plausible one rather than this
 * interface inventing a second, parallel auth-result shape for one field.
 */
export interface IptvClient {
  authenticate(): Promise<XtreamAuthResponse>
  getLiveCategories(): Promise<Category[]>
  getLiveStreams(categoryId?: string): Promise<LiveStream[]>
  getVodCategories(): Promise<Category[]>
  getVodStreams(categoryId?: string): Promise<VodStream[]>
  getSeriesCategories(): Promise<Category[]>
  getSeries(categoryId?: string): Promise<SeriesItem[]>
  getSeriesInfo(seriesId: number): Promise<SeriesInfo>
  getShortEpg(streamId: number, limit?: number): Promise<ShortEpgProgram[]>
  getFullEpgXml(): Promise<string>
  getStreamUrl(kind: MediaKind, streamId: number, extension: string): string
  getTimeshiftUrl(streamId: number, start: Date, durationMinutes: number, extension?: string): string
}
