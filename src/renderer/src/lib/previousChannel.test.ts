import { describe, expect, it } from 'vitest'
import { previousLiveChannel, rememberLiveChannel, type PreviousLiveChannel } from './previousChannel'

const channel = (streamId: number, playlistId: string | null = null): PreviousLiveChannel => ({
  streamId,
  name: `Channel ${streamId}`,
  icon: '',
  tvArchive: 0,
  playlistId
})

describe('previous channel', () => {
  it('has nothing to go back to until a second channel is played', () => {
    const history = rememberLiveChannel([], channel(1))
    expect(previousLiveChannel(history)).toBeNull()
  })

  it('remembers the channel just left, and pressing again goes back to it', () => {
    let history = rememberLiveChannel([], channel(1))
    history = rememberLiveChannel(history, channel(2))
    expect(previousLiveChannel(history)?.streamId).toBe(1)

    // Pressing "previous" plays channel 1 — which makes channel 2 the previous one.
    history = rememberLiveChannel(history, channel(1))
    expect(previousLiveChannel(history)?.streamId).toBe(2)
  })

  it('does not treat a re-play of the same channel as a change', () => {
    let history = rememberLiveChannel([], channel(1))
    history = rememberLiveChannel(history, channel(2))
    const again = rememberLiveChannel(history, channel(2))
    expect(again).toBe(history)
    expect(previousLiveChannel(again)?.streamId).toBe(1)
  })

  it('keeps only two entries — a remote remembers one channel back, not a history', () => {
    let history: PreviousLiveChannel[] = []
    for (const id of [1, 2, 3, 4]) history = rememberLiveChannel(history, channel(id))
    expect(history.map((c) => c.streamId)).toEqual([4, 3])
    expect(previousLiveChannel(history)?.streamId).toBe(3)
  })

  it('keeps the same id on two playlists as two different channels', () => {
    let history = rememberLiveChannel([], channel(42, 'primary'))
    history = rememberLiveChannel(history, channel(42, 'second'))
    expect(previousLiveChannel(history)).toMatchObject({ streamId: 42, playlistId: 'primary' })
  })
})
