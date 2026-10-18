/**
 * Reading an MPEG-TS program map without ffmpeg.
 *
 * probeTracks used to spawn `ffmpeg -i <live source>` and read its stderr — correct, but on a
 * live HLS source that is seconds of network reads (and, when the player is loading the same
 * channel at the same moment, a second sustained provider connection the account may not have:
 * measured 2026-10-18, the probe raced the player's own direct attempt for the same Sky Sports
 * FHD channel until it hit its full 30s backstop while the viewer watched a black screen). The
 * facts the routing decision needs — which audio codecs the multiplex carries, and in what
 * order, plus the video codec — are all stated in one place ffmpeg itself reads them from: the
 * PAT/PMT at the head of any TS segment. One playlist hop plus the first ~256KB of one segment
 * answers the same question in ~1-2s with no ffmpeg at all.
 *
 * Deliberately a pure parser over bytes (same convention as the rest of this lib, see
 * transcodeService.test.ts) so it is unit-testable against synthetic packets and real segment
 * slices alike. Anything it cannot confidently read — encrypted segments, fMP4, exotic stream
 * types, no PAT — resolves to null, and the caller keeps the ffmpeg probe as its fallback
 * rather than guessing.
 */

const PACKET_BYTES = 188
const PAT_PID = 0x0000

/** ES stream types this app's decisions depend on, as ffmpeg would name the codec. */
const STREAM_TYPE_CODEC_NAMES: Record<number, string> = {
  0x01: 'mpeg2video',
  0x02: 'mpeg2video',
  0x1b: 'h264',
  0x24: 'hevc',
  0x42: 'hevc',
  0x43: 'hevc',
  0x44: 'hevc',
  0x03: 'mp3',
  0x04: 'mp3',
  0x0f: 'aac',
  0x11: 'aac',
  // ATSC A/53's own assignments; 0x87 is what this provider's E-AC-3 tracks actually carry
  // (verified against a real Sky Sports FHD segment, 2026-10-18).
  0x81: 'ac3',
  0x84: 'eac3',
  0x87: 'eac3'
}

const VIDEO_CODEC_NAMES = new Set(['mpeg2video', 'h264', 'hevc'])

export interface TsProgramStreams {
  /** Elementary streams of the first program, in PMT order — the order ffmpeg reports them in too. */
  elementaryStreams: Array<{ pid: number; streamType: number; codec: string | null }>
  /** The video codec as ffmpeg names it, or null when the PMT named none this app knows. */
  videoCodec: string | null
  /** Audio codecs in track order — exactly what the playback route's audio decision consumes. */
  audioCodecs: string[]
}

/** Read one packet's payload start (past the adaptation field) and its payload-unit-start flag. */
function packetPayload(bytes: Buffer, offset: number): { pid: number; pusi: boolean; start: number; end: number } | null {
  if (bytes.readUInt8(offset) !== 0x47) return null
  const flags = bytes.readUInt8(offset + 1)
  const pid = ((flags & 0x1f) << 8) | bytes.readUInt8(offset + 2)
  const adaptationFieldControl = (bytes.readUInt8(offset + 3) >> 4) & 0x3
  let start = offset + 4
  if (adaptationFieldControl & 0x2) start += 1 + bytes.readUInt8(start)
  if (adaptationFieldControl & 0x1) return { pusi: (flags & 0x40) !== 0, start, end: offset + PACKET_BYTES, pid }
  return null
}

/** PAT → the first program's PMT pid. */
function findProgramMapPid(bytes: Buffer): number | null {
  for (let off = 0; off + PACKET_BYTES <= bytes.length; off += PACKET_BYTES) {
    const packet = packetPayload(bytes, off)
    if (!packet || packet.pid !== PAT_PID || !packet.pusi) continue
    const section = packet.start + 1 + bytes.readUInt8(packet.start) // past pointer_field
    const sectionLength = ((bytes.readUInt8(section + 1) & 0x0f) << 8) | bytes.readUInt8(section + 2)
    const end = section + 3 + sectionLength - 4 // drop the trailing CRC32
    let cursor = section + 8
    while (cursor + 4 <= end) {
      const programNumber = (bytes.readUInt8(cursor) << 8) | bytes.readUInt8(cursor + 1)
      const pmtPid = ((bytes.readUInt8(cursor + 2) & 0x1f) << 8) | bytes.readUInt8(cursor + 3)
      // Program number 0 names the network PID, not a program — skip it.
      if (programNumber !== 0) return pmtPid
      cursor += 4
    }
    return null
  }
  return null
}

/**
 * Parse the first program's PMT out of an MPEG-TS slice. Null when the bytes are not a TS
 * multiplex this can read (no sync byte, no PAT, no PMT, no section at all) — the caller's
 * signal to fall back to the ffmpeg probe rather than act on a guess.
 */
export function parseTsProgramStreams(bytes: Buffer): TsProgramStreams | null {
  const pmtPid = findProgramMapPid(bytes)
  if (pmtPid === null) return null
  for (let off = 0; off + PACKET_BYTES <= bytes.length; off += PACKET_BYTES) {
    const packet = packetPayload(bytes, off)
    if (!packet || packet.pid !== pmtPid || !packet.pusi) continue
    const section = packet.start + 1 + bytes.readUInt8(packet.start) // past pointer_field
    const sectionLength = ((bytes.readUInt8(section + 1) & 0x0f) << 8) | bytes.readUInt8(section + 2)
    const end = section + 3 + sectionLength - 4
    const programInfoLength = ((bytes.readUInt8(section + 10) & 0x0f) << 8) | bytes.readUInt8(section + 11)
    let cursor = section + 12 + programInfoLength
    const elementaryStreams: TsProgramStreams['elementaryStreams'] = []
    while (cursor + 5 <= end) {
      const streamType = bytes.readUInt8(cursor)
      const esPid = ((bytes.readUInt8(cursor + 1) & 0x1f) << 8) | bytes.readUInt8(cursor + 2)
      const esInfoLength = ((bytes.readUInt8(cursor + 3) & 0x0f) << 8) | bytes.readUInt8(cursor + 4)
      elementaryStreams.push({ pid: esPid, streamType, codec: STREAM_TYPE_CODEC_NAMES[streamType] ?? null })
      cursor += 5 + esInfoLength
    }
    const named = elementaryStreams.filter((stream) => stream.codec !== null)
    // A PMT whose entries are all types this map doesn't name is a stream this parser has no
    // business describing — say nothing rather than something wrong.
    if (named.length === 0) return null
    const videoCodec = named.find((stream) => VIDEO_CODEC_NAMES.has(stream.codec as string))?.codec ?? null
    const audioCodecs = named
      .filter((stream) => !VIDEO_CODEC_NAMES.has(stream.codec as string))
      .map((stream) => stream.codec as string)
    return { elementaryStreams, videoCodec, audioCodecs }
  }
  return null
}
