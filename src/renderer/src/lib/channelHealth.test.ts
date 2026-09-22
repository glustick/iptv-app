import { describe, it, expect } from 'vitest'
import { analyzeMediaPlaylist, classifyChannelHealth, describeChannelHealth } from './channelHealth'

// The shape this app's own provider serves on many channels: a finished playlist on a live URL.
// Measured 2026-09-21 — 12 segments, TARGETDURATION=11, sum(EXTINF)=120.3s, ENDLIST present.
const FINISHED_LOOP = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:11
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.000,Programme
https://cdn.example/0.ts
#EXTINF:10.000,Programme
https://cdn.example/1.ts
#EXTINF:10.300,Programme
https://cdn.example/2.ts
#EXT-X-ENDLIST
`

// A genuinely live playlist: no ENDLIST, and a media sequence that has moved past zero.
const LIVE = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:7
#EXT-X-MEDIA-SEQUENCE:8412
#EXTINF:7.000,
https://cdn.example/a.ts
#EXTINF:7.000,
https://cdn.example/b.ts
`

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080
1080p/index.m3u8
`

describe('analyzeMediaPlaylist', () => {
  it('reads a finished playlist as finished, with its real length', () => {
    const analysis = analyzeMediaPlaylist(FINISHED_LOOP)
    expect(analysis).not.toBeNull()
    expect(analysis!.hasEndList).toBe(true)
    expect(analysis!.segmentCount).toBe(3)
    expect(analysis!.durationSeconds).toBeCloseTo(30.3, 1)
    expect(analysis!.isMaster).toBe(false)
  })

  it('reads an advancing playlist as not finished, keeping its media sequence', () => {
    const analysis = analyzeMediaPlaylist(LIVE)
    expect(analysis!.hasEndList).toBe(false)
    expect(analysis!.mediaSequence).toBe(8412)
    expect(analysis!.segmentCount).toBe(2)
  })

  it('recognises a master playlist instead of counting its variants as segments', () => {
    const analysis = analyzeMediaPlaylist(MASTER)
    expect(analysis!.isMaster).toBe(true)
    expect(analysis!.hasEndList).toBe(false)
  })

  it('rejects anything that is not a playlist — an error page, JSON, or an empty body', () => {
    expect(analyzeMediaPlaylist('')).toBeNull()
    expect(analyzeMediaPlaylist('<html><body>403 Forbidden</body></html>')).toBeNull()
    expect(analyzeMediaPlaylist('{"error":"unauthorized"}')).toBeNull()
    // A header with nothing usable after it is equally unhelpful.
    expect(analyzeMediaPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n')).toBeNull()
  })

  it('tolerates CRLF line endings (a Windows-run server, or a proxy re-encoding the body)', () => {
    const analysis = analyzeMediaPlaylist(FINISHED_LOOP.replace(/\n/g, '\r\n'))
    expect(analysis!.hasEndList).toBe(true)
    expect(analysis!.segmentCount).toBe(3)
  })
})

describe('classifyChannelHealth', () => {
  it('flags a finished playlist on a live channel — the condition that makes a channel not live', () => {
    expect(classifyChannelHealth(analyzeMediaPlaylist(FINISHED_LOOP))).toBe('loop')
  })

  it('never flags an advancing playlist', () => {
    expect(classifyChannelHealth(analyzeMediaPlaylist(LIVE))).toBe('ok')
  })

  it('refuses to judge a master playlist rather than guessing from variants it has not seen', () => {
    expect(classifyChannelHealth(analyzeMediaPlaylist(MASTER))).toBe('ok')
  })

  it('calls an unreadable body unavailable', () => {
    expect(classifyChannelHealth(analyzeMediaPlaylist('<html>nope</html>'))).toBe('unavailable')
    expect(classifyChannelHealth(null)).toBe('unavailable')
  })
})

describe('describeChannelHealth', () => {
  it('names the clip length when it is known, in words a person would use', () => {
    expect(describeChannelHealth('loop', 120.3)).toBe(
      'This channel is currently serving a fixed 2-minute loop rather than a live feed'
    )
    expect(describeChannelHealth('loop', 45)).toContain('45-second loop')
    // Exactly a minute reads as "1-minute", not "60-second".
    expect(describeChannelHealth('loop', 60)).toContain('1-minute loop')
  })

  it('still explains a loop when the length is unknown', () => {
    expect(describeChannelHealth('loop', null)).toBe(
      'This channel is currently serving a fixed loop rather than a live feed'
    )
  })

  it('says nothing for channels that are fine or not yet checked', () => {
    expect(describeChannelHealth('ok', 100)).toBeNull()
    expect(describeChannelHealth('unknown')).toBeNull()
  })
})
