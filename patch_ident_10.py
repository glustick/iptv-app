"""0.7.108 tests — playlist-aware membership and reminders."""
import io, sys

ROOT = '/Users/chrisallison/Desktop/Development/iptv-app/'
failures = []


def append(rel, text, label=''):
    path = ROOT + rel
    with io.open(path, encoding='utf-8') as fh:
        current = fh.read()
    if label and label in current:
        failures.append('%s: already contains %s' % (rel, label))
        return
    with io.open(path, 'a', encoding='utf-8') as fh:
        fh.write(text)


append(
    'src/renderer/src/lib/channelIdentity.test.ts',
    """
describe('channelEntryFor', () => {
  it('stores a primary-playlist channel as its plain number, so existing membership keeps its shape', () => {
    expect(channelEntryFor('primary', 42, 'primary')).toBe(42)
    // No playlist known at all is the same thing — it is what every entry written before
    // multi-playlist means.
    expect(channelEntryFor(null, 42, 'primary')).toBe(42)
  })

  it('stores another playlist\\'s channel as a qualified key', () => {
    expect(channelEntryFor('second', 42, 'primary')).toBe('second:42')
  })

  it('treats the number 42 and the string "42" as the same channel', () => {
    expect(isChannelEntryFor(42, 'primary', 42, 'primary')).toBe(true)
    expect(isChannelEntryFor('42', 'primary', 42, 'primary')).toBe(true)
    expect(isChannelEntryFor('second:42', 'primary', 42, 'primary')).toBe(false)
    expect(isChannelEntryFor('second:42', 'second', 42, 'primary')).toBe(true)
  })
})
""",
    'describe(\'channelEntryFor\'',
)

# the new helpers need importing in that file
path = ROOT + 'src/renderer/src/lib/channelIdentity.test.ts'
with io.open(path, encoding='utf-8') as fh:
    text = fh.read()
old = "import { channelKey, channelKeyBelongsToPlaylist, channelKeyCandidates, isChannelKeyFor } from './channelIdentity'"
if text.count(old) == 1:
    with io.open(path, 'w', encoding='utf-8') as fh:
        fh.write(
            text.replace(
                old,
                "import {\n  channelEntryFor,\n  channelKey,\n  channelKeyBelongsToPlaylist,\n  channelKeyCandidates,\n  isChannelEntryFor,\n  isChannelKeyFor\n} from './channelIdentity'",
                1,
            )
        )
else:
    failures.append('channelIdentity.test.ts: import anchor matched %d times' % text.count(old))

append(
    'src/renderer/src/lib/reminders.test.ts',
    """
describe('reminders across playlists', () => {
  it('keeps the historical id for a primary-playlist channel', () => {
    expect(reminderId(42, 'programme-1', 'primary', 'primary')).toBe('42:programme-1')
    // And for a channel whose playlist isn't known at all — every reminder written before
    // multi-playlist, which must keep matching.
    expect(reminderId(42, 'programme-1')).toBe('42:programme-1')
  })

  it("qualifies another playlist's channel, so the same id there is a different reminder", () => {
    const other = createReminder(42, 'B News', program, 'second', 'primary')
    expect(other.id).toBe('second:42:programme-1')
    expect(other.playlistId).toBe('second')
    // A primary-playlist reminder stores no playlistId at all: its id already says which it is, and
    // adding one would rewrite data that is already correct.
    expect(createReminder(42, 'A News', program, 'primary', 'primary').playlistId).toBeUndefined()
  })
})
""",
    'describe(\'reminders across playlists\'',
)

append(
    'src/renderer/src/lib/customCategories.test.ts',
    """
describe('membership entries across playlists', () => {
  it('adds a qualified key alongside a plain id, and removes each on its own', () => {
    const both = addStreamIds([42], ['second:42'])
    expect(both).toEqual([42, 'second:42'])
    expect(removeStreamId(both, 'second:42')).toEqual([42])
    expect(removeStreamId(both, 42)).toEqual(['second:42'])
  })

  it('treats the number 42 and the string "42" as the same channel', () => {
    expect(addStreamIds([42], ['42'])).toEqual([42])
    expect(removeStreamId([42], '42')).toEqual([])
  })
})
""",
    'describe(\'membership entries across playlists\'',
)

append(
    'src/renderer/src/store/useAppStore.test.ts',
    """
describe('programme reminders across playlists', () => {
  const programme: ShortEpgProgram = {
    id: 'programme-1',
    epg_id: 'epg-1',
    title: 'Evening News',
    lang: 'en',
    start: '',
    end: '',
    description: '',
    channel_id: 'channel-1',
    start_timestamp: '1100',
    stop_timestamp: '4700'
  }

  it('keeps the same channel id on two playlists as two independent reminders', () => {
    useAppStore.setState({ primaryPlaylistId: 'primary', epgReminders: [] })

    useAppStore.getState().toggleEpgReminder(42, 'B News', programme, 'second')
    expect(useAppStore.getState().isEpgReminderSet(42, 'programme-1', 'second')).toBe(true)
    // Provider A's channel 42 is a different channel: no bell of its own, so pressing it there sets
    // a second reminder rather than clearing provider B's.
    expect(useAppStore.getState().isEpgReminderSet(42, 'programme-1', 'primary')).toBe(false)
    useAppStore.getState().toggleEpgReminder(42, 'A News', programme, 'primary')
    expect(useAppStore.getState().epgReminders).toHaveLength(2)
    expect(useAppStore.getState().isEpgReminderSet(42, 'programme-1', 'primary')).toBe(true)

    // …and toggling one off leaves the other set.
    useAppStore.getState().toggleEpgReminder(42, 'A News', programme, 'primary')
    expect(useAppStore.getState().isEpgReminderSet(42, 'programme-1', 'primary')).toBe(false)
    expect(useAppStore.getState().isEpgReminderSet(42, 'programme-1', 'second')).toBe(true)
  })

  it('writes the id a single-playlist install has always written', () => {
    useAppStore.setState({ primaryPlaylistId: 'primary', epgReminders: [] })
    useAppStore.getState().toggleEpgReminder(42, 'A News', programme, 'primary')
    expect(useAppStore.getState().epgReminders[0].id).toBe('42:programme-1')
  })
})

describe('custom category membership across playlists', () => {
  it('keeps the same channel id on two playlists as two members', () => {
    useAppStore.setState({ primaryPlaylistId: 'primary' })
    const id = useAppStore.getState().createCustomCategory('Favourites')
    const entries = () => useAppStore.getState().settings.customCategories.find((c) => c.id === id)!.streamIds

    useAppStore.getState().addChannelsToCustomCategory(id, [42, 'second:42'])
    expect(entries()).toEqual([42, 'second:42'])

    // Removing the second playlist's channel leaves the primary's in place.
    useAppStore.getState().removeChannelFromCustomCategory(id, 'second:42')
    expect(entries()).toEqual([42])
  })

  it('does not add the same channel twice because it arrived in the other shape', () => {
    useAppStore.setState({ primaryPlaylistId: 'primary' })
    const id = useAppStore.getState().createCustomCategory('Mixed')
    const entries = () => useAppStore.getState().settings.customCategories.find((c) => c.id === id)!.streamIds

    useAppStore.getState().addChannelsToCustomCategory(id, [42])
    useAppStore.getState().addChannelsToCustomCategory(id, ['42'])
    expect(entries()).toEqual([42])
  })
})
""",
    'describe(\'custom category membership across playlists\'',
)

if failures:
    print('FAILED:')
    for line in failures:
        print(' -', line)
    sys.exit(1)
print('tests appended')
