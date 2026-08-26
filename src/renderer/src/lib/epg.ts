import { XMLParser } from 'fast-xml-parser'

export interface EpgChannel {
  id: string
  displayName: string
  icon?: string
}

export interface EpgProgramme {
  channelId: string
  start: Date
  stop: Date
  title: string
  description?: string
}

export interface EpgData {
  channels: Map<string, EpgChannel>
  programmesByChannel: Map<string, EpgProgramme[]>
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function textOf(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text'])
  }
  return String(value)
}

/** XMLTV timestamps look like `20240101120000 +0000`. */
function parseXmltvDate(value: string): Date {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/)
  if (!match) return new Date(value)
  const [, year, month, day, hour, minute, second, offset] = match
  const normalizedOffset = offset ? `${offset.slice(0, 3)}:${offset.slice(3)}` : 'Z'
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${normalizedOffset}`)
}

export function parseXmltv(xml: string): EpgData {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const doc = parser.parse(xml) as { tv?: { channel?: unknown; programme?: unknown } }
  const tv = doc.tv ?? {}

  const channels = new Map<string, EpgChannel>()
  for (const raw of asArray(tv.channel as any)) {
    const id = String(raw['@_id'])
    const displayName = textOf(raw['display-name']) ?? id
    const icon = raw.icon?.['@_src']
    channels.set(id, { id, displayName, icon })
  }

  const programmesByChannel = new Map<string, EpgProgramme[]>()
  for (const raw of asArray(tv.programme as any)) {
    const channelId = String(raw['@_channel'])
    const programme: EpgProgramme = {
      channelId,
      start: parseXmltvDate(String(raw['@_start'])),
      stop: parseXmltvDate(String(raw['@_stop'])),
      title: textOf(raw.title) ?? 'Untitled',
      description: textOf(raw.desc)
    }
    const list = programmesByChannel.get(channelId)
    if (list) {
      list.push(programme)
    } else {
      programmesByChannel.set(channelId, [programme])
    }
  }

  for (const list of programmesByChannel.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime())
  }

  return { channels, programmesByChannel }
}

export function getCurrentProgramme(
  programmes: EpgProgramme[] | undefined,
  at: Date = new Date()
): EpgProgramme | undefined {
  return programmes?.find((p) => p.start <= at && at < p.stop)
}

export function getNextProgramme(
  programmes: EpgProgramme[] | undefined,
  at: Date = new Date()
): EpgProgramme | undefined {
  return programmes?.find((p) => p.start > at)
}
