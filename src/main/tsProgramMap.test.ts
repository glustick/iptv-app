import { describe, expect, it } from 'vitest'
import { parseTsProgramStreams } from './tsProgramMap.js'

// A minimal MPEG-TS writer for the parser's tests: one PAT naming one program, then one PMT
// naming whatever elementary streams a case needs. Real-world shapes exercised against genuine
// provider segments during development (a Sky Sports FHD multiplex: h264 + eac3×2 + aac×2, PAT
// and PMT inside the first kilobyte); the synthetic form here pins the same facts without a
// binary fixture in the tree.
const PACKET = 188

function packet(pid: number, payload: Buffer, { payloadUnitStart = true, adaptation = 0 } = {}): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt8(0x47, 0)
  header.writeUInt8(((payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f)) & 0xff, 1)
  header.writeUInt8(pid & 0xff, 2)
  // An adaptation field (stuffing) whenever one is asked for or the payload leaves room: its
  // length byte plus its stated bytes plus the payload must land exactly on the packet size.
  const afLength = PACKET - 5 - payload.length
  const useAdaptation = afLength >= 0 && (adaptation > 0 || payload.length < PACKET - 4)
  header.writeUInt8(useAdaptation ? 0x30 : 0x10, 3)
  const parts: Buffer[] = [header]
  if (useAdaptation) {
    const af = Buffer.alloc(1 + afLength, 0)
    af.writeUInt8(afLength, 0)
    parts.push(af)
  }
  parts.push(payload)
  const out = Buffer.concat(parts)
  return out.length === PACKET ? out : Buffer.concat([out, Buffer.alloc(PACKET - out.length, 0xff)])
}

function pointerSection(tableId: number, fixed: Buffer, entries: Buffer): Buffer {
  // pointer_field 0, then the section: table_id + section_length (covering fixed header, the
  // entries, and the CRC32), the 5-byte fixed header every syntax-section carries (TSID or
  // program_number, version, section numbers), then the entries, then a (unchecked) CRC.
  const content = Buffer.concat([fixed, entries])
  const head = Buffer.alloc(3)
  head.writeUInt8(tableId, 0)
  head.writeUInt8(0xb0 | ((content.length + 4) >> 8), 1)
  head.writeUInt8((content.length + 4) & 0xff, 2)
  return Buffer.concat([Buffer.from([0]), head, content, Buffer.alloc(4, 0)])
}

function sectionHeader(idOrProgram: number): Buffer {
  // transport_stream_id / program_number(2), reserved+version+current(1), section_number(1),
  // last_section_number(1)
  const fixed = Buffer.alloc(5)
  fixed.writeUInt16BE(idOrProgram, 0)
  fixed.writeUInt8(0xc1, 2)
  return fixed
}

function pat(programNumber: number, pmtPid: number, networkPid = 0): Buffer {
  const entries = Buffer.alloc(8)
  entries.writeUInt16BE(programNumber, 0)
  entries.writeUInt16BE(0xe000 | pmtPid, 2)
  entries.writeUInt16BE(0, 4) // program_number 0 → the network PID entry
  entries.writeUInt16BE(0xe000 | networkPid, 6)
  return pointerSection(0x00, sectionHeader(1), entries)
}

function pmt(entries: Array<{ streamType: number; pid: number; descriptors?: Buffer }>): Buffer {
  const fixed = Buffer.concat([sectionHeader(1), Buffer.from([0xe1, 0xff, 0xf0, 0x00])]) // PCR pid, no program descriptors
  const body: Buffer[] = []
  for (const entry of entries) {
    const es = Buffer.alloc(5)
    es.writeUInt8(entry.streamType, 0)
    es.writeUInt16BE(0xe000 | entry.pid, 1)
    const descriptors = entry.descriptors ?? Buffer.alloc(0)
    es.writeUInt16BE(0xf000 | descriptors.length, 3)
    body.push(es, descriptors)
  }
  return pointerSection(0x02, fixed, Buffer.concat(body))
}

// The stream types the provider's real multiplexes carry (read off genuine Sky Sports FHD and
// HD segments, 2026-10-18): 0x1b H.264 video, 0x87 E-AC-3, 0x0f ADTS AAC.
const FHD_SHAPE = [
  { streamType: 0x1b, pid: 0x100 },
  { streamType: 0x87, pid: 0x101 },
  { streamType: 0x87, pid: 0x102 },
  { streamType: 0x0f, pid: 0x103 },
  { streamType: 0x0f, pid: 0x104 }
]

function tsWith(entries: Array<{ streamType: number; pid: number; descriptors?: Buffer }>, extra: Buffer[] = []): Buffer {
  return Buffer.concat([packet(0x0000, pat(1, 0x1000, 0x1fff)), packet(0x1000, pmt(entries)), ...extra])
}

describe('parseTsProgramStreams', () => {
  it('reads the Sky Sports FHD shape: h264 video and eac3×2 + aac×2 audio in PMT order', () => {
    const parsed = parseTsProgramStreams(tsWith(FHD_SHAPE))
    expect(parsed?.videoCodec).toBe('h264')
    expect(parsed?.audioCodecs).toEqual(['eac3', 'eac3', 'aac', 'aac'])
  })

  it('names HEVC video and AC-3 audio by their ATSC stream types', () => {
    const parsed = parseTsProgramStreams(tsWith([
      { streamType: 0x24, pid: 0x100 },
      { streamType: 0x81, pid: 0x101 }
    ]))
    expect(parsed?.videoCodec).toBe('hevc')
    expect(parsed?.audioCodecs).toEqual(['ac3'])
  })

  it('skips elementary-stream descriptors it does not understand, without losing later entries', () => {
    const parsed = parseTsProgramStreams(tsWith([
      { streamType: 0x1b, pid: 0x100, descriptors: Buffer.from([0x0a, 0x04, 'eng'.charCodeAt(0), 'e'.charCodeAt(0), 'n'.charCodeAt(0), 'g'.charCodeAt(0)]) },
      { streamType: 0x0f, pid: 0x101 }
    ]))
    expect(parsed?.videoCodec).toBe('h264')
    expect(parsed?.audioCodecs).toEqual(['aac'])
  })

  it('survives adaptation-field stuffing before the section payload', () => {
    const parsed = parseTsProgramStreams(
      Buffer.concat([packet(0x0000, pat(1, 0x1000, 0x1fff), { adaptation: 16 }), packet(0x1000, pmt(FHD_SHAPE), { adaptation: 8 })])
    )
    expect(parsed?.audioCodecs).toEqual(['eac3', 'eac3', 'aac', 'aac'])
  })

  it('answers null when the PMT names only stream types it cannot identify', () => {
    expect(parseTsProgramStreams(tsWith([{ streamType: 0x06, pid: 0x100 }]))).toBeNull()
  })

  it('answers null for bytes that are not a TS multiplex it can read', () => {
    expect(parseTsProgramStreams(Buffer.alloc(2048, 0x00))).toBeNull()
    expect(parseTsProgramStreams(Buffer.from('not a transport stream at all'.padEnd(2048, '.')))).toBeNull()
    expect(parseTsProgramStreams(Buffer.alloc(0))).toBeNull()
  })

  it('answers null when the PAT exists but no PMT packet follows', () => {
    const onlyPat = packet(0x0000, pat(1, 0x1000, 0x1fff))
    expect(parseTsProgramStreams(onlyPat)).toBeNull()
  })

  it('reads the PMT even when unrelated PES packets surround the tables', () => {
    const noise = packet(0x0100, Buffer.alloc(160, 0xab), { payloadUnitStart: false })
    const parsed = parseTsProgramStreams(
      Buffer.concat([noise, packet(0x0000, pat(1, 0x1000, 0x1fff)), noise, packet(0x1000, pmt(FHD_SHAPE)), noise])
    )
    expect(parsed?.videoCodec).toBe('h264')
    expect(parsed?.audioCodecs).toEqual(['eac3', 'eac3', 'aac', 'aac'])
  })
})
