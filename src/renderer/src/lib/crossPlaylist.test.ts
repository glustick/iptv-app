import { describe, expect, it } from 'vitest'
import { channelMatchKey, findAlsoOnCandidates } from './crossPlaylist.js'
import type { LiveStream } from './types.js'

// The manual "Also on …" switch (0.16.0). channelMatchKey is ported code-identical from the web
// sibling (tests and all), so both apps match channels the same way; findAlsoOnCandidates is
// the desktop adaptation over the merged catalogue.

const asLive = (
  streamId: number,
  name: string,
  playlistId?: string,
  playlistName?: string,
  category = 'Sports'
): LiveStream => ({
  num: 0,
  name,
  stream_type: 'live',
  stream_id: streamId,
  stream_icon: '',
  epg_channel_id: null,
  added: '',
  category_id: category,
  custom_sid: null,
  tv_archive: 1,
  tv_archive_duration: 7,
  direct_source: '',
  ...(playlistId ? { playlistId, playlistName: playlistName ?? playlistId } : {})
})

describe('channelMatchKey (ported from the web sibling)', () => {
  it('matches the same channel across two providers, which renumber everything', () => {
    const a = channelMatchKey({ name: 'UK: Sky Sports Main Event UHD', category: 'UK Sports' })
    const b = channelMatchKey({ name: 'Sky Sports Main Event', category: 'uk sports' })
    expect(a).toBe(b)
  })

  it('separates channels that really are different', () => {
    const main = channelMatchKey({ name: 'Sky Sports Main Event', category: 'Sports' })
    const f1 = channelMatchKey({ name: 'Sky Sports F1', category: 'Sports' })
    expect(main).not.toBe(f1)
  })

  it('ignores punctuation, case and quality suffixes, but not a missing category', () => {
    expect(channelMatchKey({ name: 'Sky News HD' })).toBe(channelMatchKey({ name: 'sky news' }))
    expect(channelMatchKey({ name: 'Sky News', category: 'News' })).not.toBe(
      channelMatchKey({ name: 'Sky News', category: 'Sports' })
    )
  })
})

describe('findAlsoOnCandidates', () => {
  const PRIMARY = 'primary-profile'
  const catalog: LiveStream[] = [
    // The primary's own row (untagged = primary) plus a second, differently-tagged same-name row.
    asLive(668, 'UK: Sky Sports Main Event UHD'),
    asLive(4242, 'Sky Sports Main Event', 'backup-profile', 'Backup'),
    // A third line carrying the same channel under yet another id.
    asLive(90210, 'Sky Sports Main Event HD', 'third-profile', 'Third'),
    // Same id as the primary's row, DIFFERENT channel — must never be offered by id alone.
    asLive(668, 'Discovery Turbo', 'backup-profile', 'Backup')
  ]

  it('offers every other playlist carrying the same channel, normalising tags and quality words', () => {
    const candidates = findAlsoOnCandidates({ name: 'Sky Sports Main Event', playlistId: undefined }, catalog, PRIMARY)
    expect(candidates.map((c) => c.playlistId).sort()).toEqual(['backup-profile', 'third-profile'])
    const backup = candidates.find((c) => c.playlistId === 'backup-profile')
    // The candidate is the OTHER playlist's own row — its stream id, ready for play().
    expect(backup).toMatchObject({ streamId: 4242, playlistName: 'Backup', tvArchive: 1 })
  })

  it('never offers the playlist the row belongs to, and never matches by bare stream id', () => {
    // From the backup's own row: the primary and third line answer; the backup does not — and
    // the backup's channel 668 (Discovery Turbo) is not offered despite sharing the id.
    const fromBackup = findAlsoOnCandidates({ name: 'Sky Sports Main Event', playlistId: 'backup-profile' }, catalog, PRIMARY)
    // The untagged primary row resolves to the primary playlist's id by design.
    expect(fromBackup.map((c) => c.playlistId).sort()).toEqual(['primary-profile', 'third-profile'])
    expect(fromBackup.every((c) => c.name.toLowerCase().includes('sky sports'))).toBe(true)
  })

  it('a category mismatch does not hide the offer (providers never spell categories alike)', () => {
    const sparse = [
      asLive(1, 'BBC One HD', 'other-profile', 'Other', 'Entertainment | UK'),
      asLive(2, 'BBC One', undefined, undefined, 'ENTERTAINMENT')
    ]
    const candidates = findAlsoOnCandidates({ name: 'BBC One', playlistId: undefined }, sparse, PRIMARY)
    expect(candidates.map((c) => c.playlistId)).toEqual(['other-profile'])
  })

  it('answers nothing when no other line carries the channel, or the name normalises to nothing', () => {
    expect(findAlsoOnCandidates({ name: 'Channel Only I Have', playlistId: undefined }, catalog, PRIMARY)).toEqual([])
    expect(findAlsoOnCandidates({ name: '!!!', playlistId: undefined }, catalog, PRIMARY)).toEqual([])
  })
})
