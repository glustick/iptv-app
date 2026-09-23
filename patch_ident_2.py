from pathlib import Path

# ---- the helper gains a playlist-scoping predicate (for counting/scope queries) ----
p = Path('src/renderer/src/lib/channelIdentity.ts')
s = p.read_text(encoding='utf-8')
s = s.rstrip('\n') + """

/**
 * Whether a stored key belongs to `playlistId`'s line-up. A bare key belongs to the primary (that is
 * all it can mean), a qualified key names its own playlist. Used for scope questions — "how many
 * hidden channels are there in what I am looking at" — where there is no channel object to hand.
 */
export function channelKeyBelongsToPlaylist(
  key: string,
  playlistId: string | null | undefined,
  primaryPlaylistId: string | null | undefined
): boolean {
  const separatorAt = key.indexOf(SEPARATOR)
  if (separatorAt < 0) return !playlistId || !primaryPlaylistId || playlistId === primaryPlaylistId
  return key.slice(0, separatorAt) === playlistId
}
"""
p.write_text(s, encoding='utf-8')
print('helper extended')

p = Path('src/renderer/src/lib/channelIdentity.test.ts')
s = p.read_text(encoding='utf-8')
s = s.rstrip('\n') + """

describe('channelKeyBelongsToPlaylist', () => {
  it('gives a bare key to the primary, and a qualified key to its own playlist', () => {
    expect(channelKeyBelongsToPlaylist('42', 'primary', 'primary')).toBe(true)
    expect(channelKeyBelongsToPlaylist('42', 'second', 'primary')).toBe(false)
    expect(channelKeyBelongsToPlaylist('second:42', 'second', 'primary')).toBe(true)
    expect(channelKeyBelongsToPlaylist('second:42', 'primary', 'primary')).toBe(false)
  })
})
"""
p.write_text(s, encoding='utf-8')
print('helper tests extended')

# ---- store: primary playlist id, isChannelHidden, key-aware toggle, audio-fix keys ----
p = Path('src/renderer/src/store/useAppStore.ts')
s = p.read_text(encoding='utf-8')
def sub_once(old, new, tag):
    global s
    assert s.count(old) == 1, f'[{tag}] expected 1, found {s.count(old)}: {old[:70]!r}'
    s = s.replace(old, new, 1)

sub_once(
    "  playlists: PlaylistConnection[]\n  selectedPlaylistId: string | null\n",
    "  playlists: PlaylistConnection[]\n  selectedPlaylistId: string | null\n"
    "  // The playlist whose channels keep their bare `stream_id` as their identity in everything\n"
    "  // stored per channel (see lib/channelIdentity) — the first connected one.\n"
    "  primaryPlaylistId: string | null\n",
    'primary id field'
)
sub_once(
    "  playlists: [],\n  selectedPlaylistId: null,\n",
    "  playlists: [],\n  selectedPlaylistId: null,\n  primaryPlaylistId: null,\n",
    'primary id default'
)
sub_once(
    "  playlists: connections,\n        selectedPlaylistId: profile.id,",
    "  playlists: connections,\n        selectedPlaylistId: profile.id,\n        primaryPlaylistId: connections[0]?.profileId ?? null,",
    'primary id on connect'
)

# isChannelHidden beside the toggle it complements
sub_once(
    "  hiddenChannelKeys: string[]\n",
    "  hiddenChannelKeys: string[]\n",
    'noop'
) if False else None
p.write_text(s, encoding='utf-8')
print('store: primary playlist id wired')
