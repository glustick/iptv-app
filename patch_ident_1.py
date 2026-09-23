from pathlib import Path

def patch(path, pairs):
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    for old, new, tag in pairs:
        assert s.count(old) == 1, f'{path} [{tag}]: expected 1, found {s.count(old)}: {old[:70]!r}'
        s = s.replace(old, new, 1)
    p.write_text(s, encoding='utf-8')
    print('patched', path, f'({len(pairs)})')

# ---------------------------------------------------------------- types
patch('src/renderer/src/lib/types.ts', [(
    """  hiddenLiveStreamIds: number[]
  liveAudioFixes: Record<string, { audioIndex: number; url: string }>""",
    """  // Hidden channels, keyed with lib/channelIdentity so the same id on two playlists stays two
  // different channels. A channel on the primary playlist keys as its plain id — which is what
  // everything stored before multi-playlist means — and other playlists' channels are qualified.
  hiddenChannelKeys: string[]
  // Remembered per-channel audio fixes, keyed the same way (a fix remembered for one provider's
  // channel 42 must not be applied to another provider's 42).
  liveAudioFixes: Record<string, { audioIndex: number; url: string }>""",
    'settings fields'
), (
    """  hiddenLiveStreamIds: [],""",
    """  hiddenChannelKeys: [],""",
    'settings default'
)])

# ---------------------------------------------------------------- storage: migrate the old field
patch('src/renderer/src/lib/storage.ts', [(
    """  if (!Array.isArray(result.hiddenLiveStreamIds)) {
    console.warn('[settings] hiddenLiveStreamIds was not an array on disk — resetting it')
    result.hiddenLiveStreamIds = []
  }""",
    """  // Migrated from hiddenLiveStreamIds (numbers) in 0.7.107: those were all the primary playlist's,
  // and channelIdentity keys those by their plain id, so the values carry over unchanged — one
  // string per old number, no interpretation needed.
  if (!Array.isArray(result.hiddenChannelKeys)) {
    const legacy = (result as { hiddenLiveStreamIds?: unknown }).hiddenLiveStreamIds
    if (Array.isArray(legacy)) {
      result.hiddenChannelKeys = legacy.filter((id) => typeof id === 'number').map((id) => String(id))
    } else {
      console.warn('[settings] hiddenChannelKeys was not an array on disk — resetting it')
      result.hiddenChannelKeys = []
    }
  }
  delete (result as { hiddenLiveStreamIds?: unknown }).hiddenLiveStreamIds""",
    'migration'
)])
