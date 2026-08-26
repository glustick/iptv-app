export interface XtreamProfile {
  id: string
  name: string
  server: string
  username: string
  password: string
}

export interface XtreamUserInfo {
  auth?: number
  username: string
  password: string
  status: string
  exp_date: string | null
  is_trial: string
  active_cons: string
  created_at: string
  max_connections: string
}

export interface XtreamServerInfo {
  url: string
  port: string
  https_port: string
  server_protocol: string
  timezone: string
}

export interface XtreamAuthResponse {
  user_info: XtreamUserInfo
  server_info: XtreamServerInfo
}

export interface Category {
  category_id: string
  category_name: string
  parent_id: number
}

export interface LiveStream {
  num: number
  name: string
  stream_type: string
  stream_id: number
  stream_icon: string
  epg_channel_id: string | null
  added: string
  category_id: string
  custom_sid: string | null
  tv_archive: number
  direct_source: string
  tv_archive_duration: number
}

export interface VodStream {
  num: number
  name: string
  stream_type: string
  stream_id: number
  stream_icon: string
  rating: string
  rating_5based: number
  added: string
  category_id: string
  container_extension: string
}

export interface SeriesItem {
  num: number
  name: string
  series_id: number
  cover: string
  plot: string
  cast: string
  director: string
  genre: string
  releaseDate: string
  rating: string
  category_id: string
}

export interface SeriesEpisode {
  id: string
  episode_num: number
  title: string
  container_extension: string
  season: number
}

export interface SeriesInfo {
  seasons: Array<{ season_number: number; name: string; cover: string }>
  episodes: Record<string, SeriesEpisode[]>
}

export interface ShortEpgProgram {
  id: string
  epg_id: string
  title: string
  lang: string
  start: string
  end: string
  description: string
  channel_id: string
  start_timestamp: string
  stop_timestamp: string
}

export type MediaKind = 'live' | 'movie' | 'series'
