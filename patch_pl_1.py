from pathlib import Path

def patch(path, pairs):
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    for old, new, tag in pairs:
        assert s.count(old) == 1, f'{path} [{tag}]: expected 1, found {s.count(old)}: {old[:70]!r}'
        s = s.replace(old, new, 1)
    p.write_text(s, encoding='utf-8')
    print('patched', path, f'({len(pairs)})')

# ---------------------------------------------------------------- types: the enabled-playlist list
patch('src/renderer/src/lib/types.ts', [(
    """  // Guide sources whose listings are switched off without being deleted""",
    """  // Which saved profiles are connected *at the same time*, in display order — the multi-playlist
  // feature. One entry means the single-provider behaviour this app has always had; more means their
  // catalogues are browsed together, grouped by playlist, each channel carrying the playlist it came
  // from. Hiding a playlist removes it from here, which also stops it being connected: the point of
  // hiding is to avoid carrying a few thousand channels you do not want, so not loading them at all
  // is the honest interpretation. The first entry is the primary — the one that owns the non-live
  // surfaces (VOD/series) and the app's single `client`.
  enabledPlaylistIds: string[]
  // Guide sources whose listings are switched off without being deleted""",
    'settings field'
), (
    """  hiddenEpgSourceUrls: [],""",
    """  hiddenEpgSourceUrls: [],
  enabledPlaylistIds: [],""",
    'settings default'
)])

# ---------------------------------------------------------------- store: the model
patch('src/renderer/src/store/useAppStore.ts', [(
    """  client: IptvClient | null""",
    """  client: IptvClient | null
  // Every connected playlist, in display order — the first is also `client`/`activeProfile` above,
  // which stay in place so the single-provider surfaces (VOD, series, the guide pool) keep working
  // unchanged. Each entry's client is built to route through the proxy's per-request passthrough
  // (see lib/xtream.ts), which is what lets more than one account be live at once.
  playlists: PlaylistConnection[]""",
    'state field'
), (
    """  requestCategory: (categoryId: string | null) => void""",
    """  // Connects/disconnects one playlist. Adding re-connects, dropping tears that account's client
  // down — see AppSettings.enabledPlaylistIds for why hiding is modelled as "not connected".
  setPlaylistEnabled: (profileId: string, enabled: boolean) => Promise<void>
  // Which playlist's categories the sidebar is showing (and whose channels the grid lists).
  selectedPlaylistId: string | null
  selectPlaylist: (profileId: string) => void
  requestCategory: (categoryId: string | null, playlistId?: string | null) => void""",
    'actions'
), (
    """  client: null,""",
    """  client: null,
  playlists: [],
  selectedPlaylistId: null,""",
    'defaults'
)])

# the exported type
patch('src/renderer/src/store/useAppStore.ts', [(
    """export type ViewMode = 'live' | 'movies' | 'series' | 'favorites' | 'history' | 'multiview'""",
    """/** One connected playlist: the saved profile it came from, plus its own client and status. */
export interface PlaylistConnection {
  profileId: string
  name: string
  client: IptvClient
  /** Per-playlist so one bad account can be shown as failing without hiding the healthy one. */
  error: string | null
}

export type ViewMode = 'live' | 'movies' | 'series' | 'favorites' | 'history' | 'multiview'""",
    'PlaylistConnection type'
)])
