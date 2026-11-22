/**
 * Pure helpers behind Player.tsx's VPN-aware playback recovery (0.36.0).
 *
 * Until now a tunnel drop only repainted status dots: a stream routed through the VPN would
 * silently stall or die with nothing in the player explaining why, and nothing resuming it
 * when the tunnel came back. Recovery needs to know whether the *playing* stream actually
 * rides the tunnel — and the player can't tell from its own URL: nowPlaying.url is the local
 * proxy URL (or a direct stream URL built from credentials), never a provider host. What the
 * player CAN know is which playlist the stream belongs to (nowPlaying.playbackPlaylistId, or
 * the primary playlist when it is null), and the store can map that playlist to its saved
 * Xtream profile's server. A stream is "tunneled" iff its playlist's provider host is one of
 * the hosts the active tunnel actually routes (vpn:route-state from the main process — see
 * setVpnStatus/startVpn in src/main/index.ts).
 *
 * Deliberately dependency-free, like reconnectBackoff.
 */

import type { XtreamProfile } from './types'

/**
 * The hostname a server URL points at, lowercased — or null when it isn't parseable as a URL.
 * Matches how the main process builds the tunneled host list (startVpn maps every connected
 * provider's server URL through the same hostname + lowercase rule).
 */
export function extractProviderHost(serverUrl: string): string | null {
  try {
    return new URL(serverUrl).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * The provider host(s) the playlist a stream is playing from is served by — empty when the
 * answer is honestly "unknown": no playlist id, a playlist whose profile isn't saved anymore,
 * an M3U profile (an M3U can reference a different host per channel — see lib/m3uClient.ts —
 * and the tunnel routes none of them; activateVpnProfile sends only Xtream profiles' servers),
 * or a profile without a server URL.
 *
 * Only the primary `server` counts, not `backupServer`: the tunnel routes exactly the hosts
 * activateVpnProfile hands to vpn:connect, and that list contains primary servers only. A
 * stream currently being served from the backup host is therefore genuinely NOT tunneled and
 * this returning [] for it is the honest answer, not an omission.
 */
export function playingProviderHosts(playlistId: string | null, profiles: XtreamProfile[]): string[] {
  if (!playlistId) return []
  const profile = profiles.find((candidate) => candidate.id === playlistId)
  if (!profile || profile.kind === 'm3u' || !profile.server) return []
  const host = extractProviderHost(profile.server)
  return host ? [host] : []
}

/**
 * Whether the stream being played rides the active tunnel: true iff at least one of the
 * playing playlist's provider hosts is in the tunnel's routed-host list. Both sides are
 * compared case-insensitively (the main process lowercases; this side shouldn't have to
 * trust that). Empty on either side means "no" — no evidence of tunneling is no tunneling,
 * and an unconnected tunnel (empty list) leaves this feature inert by design.
 */
export function isTunneledNowPlaying(providerHosts: string[], tunneledHosts: string[]): boolean {
  if (providerHosts.length === 0 || tunneledHosts.length === 0) return false
  const tunneled = new Set(tunneledHosts.map((host) => host.toLowerCase()))
  return providerHosts.some((host) => tunneled.has(host.toLowerCase()))
}
