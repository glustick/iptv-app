import { describe, expect, it } from 'vitest'
import { stepChannel, visibleLiveChannelList } from './channelStep'
import type { LiveStream } from './types'

function channel(id: number, name = `Channel ${id}`): LiveStream {
  return {
    num: id,
    name,
    stream_type: 'live',
    stream_id: id,
    stream_icon: '',
    epg_channel_id: null,
    added: '',
    category_id: '1',
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

describe('visibleLiveChannelList', () => {
  it('keeps hidden channels out unless the viewer chose to see them', () => {
    const streams = [channel(1), channel(2), channel(3)]
    const isHidden = (_playlistId: string | null | undefined, streamId: number) => streamId === 2
    expect(visibleLiveChannelList(streams, false, isHidden).map((c) => c.stream_id)).toEqual([1, 3])
    expect(visibleLiveChannelList(streams, true, isHidden).map((c) => c.stream_id)).toEqual([1, 2, 3])
  })

  it('keeps the catalogue order untouched', () => {
    const streams = [channel(3), channel(1), channel(2)]
    const none = (): boolean => false
    expect(visibleLiveChannelList(streams, false, none).map((c) => c.stream_id)).toEqual([3, 1, 2])
  })
})

describe('stepChannel', () => {
  const list = [channel(10), channel(20), channel(30)]

  it('steps down and up the list', () => {
    expect(stepChannel(list, 10, 1)?.stream_id).toBe(20)
    expect(stepChannel(list, 20, 1)?.stream_id).toBe(30)
    expect(stepChannel(list, 30, -1)?.stream_id).toBe(20)
  })

  it('wraps around at both ends', () => {
    expect(stepChannel(list, 30, 1)?.stream_id).toBe(10)
    expect(stepChannel(list, 10, -1)?.stream_id).toBe(30)
  })

  it('answers null when the current channel is not in the list', () => {
    expect(stepChannel(list, 99, 1)).toBeNull()
    expect(stepChannel(list, 99, -1)).toBeNull()
  })

  it('answers null for a list with nothing to step to', () => {
    expect(stepChannel([], 10, 1)).toBeNull()
    expect(stepChannel([channel(10)], 10, 1)).toBeNull()
    expect(stepChannel([channel(10)], 99, 1)).toBeNull()
  })
})
