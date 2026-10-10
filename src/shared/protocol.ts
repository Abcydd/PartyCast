export const PROTOCOL_VERSION = 1 as const

export type Participant = { peerId: string; name: string; connection: 'connecting' | 'connected' | 'failed' }
export type Message =
  | { version: 1; type: 'hello'; name: string; role: 'host' | 'viewer' }
  | { version: 1; type: 'roster'; participants: Participant[] }
  | {
      version: 1
      type: 'state'
      playing: boolean
      currentTime: number
      duration: number
      title: string | null
    }
  | { version: 1; type: 'kick'; reason: 'kicked' | 'room-full' }
  | { version: 1; type: 'room-closed' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 40
const isPeerId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export function decodeMessage(raw: unknown): Message | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) return null
  switch (value.type) {
    case 'hello':
      return isName(value.name) && (value.role === 'host' || value.role === 'viewer')
        ? { version: 1, type: 'hello', name: value.name.trim(), role: value.role }
        : null
    case 'roster':
      return Array.isArray(value.participants) &&
        value.participants.length <= 64 &&
        value.participants.every(
          (p: unknown) =>
            isRecord(p) &&
            isPeerId(p.peerId) &&
            isName(p.name) &&
            ['connecting', 'connected', 'failed'].includes(String(p.connection)),
        )
        ? { version: 1, type: 'roster', participants: value.participants as Participant[] }
        : null
    case 'state':
      return typeof value.playing === 'boolean' &&
        isTime(value.currentTime) &&
        isTime(value.duration) &&
        (value.title === null || (typeof value.title === 'string' && value.title.length <= 256))
        ? {
            version: 1,
            type: 'state',
            playing: value.playing,
            currentTime: value.currentTime,
            duration: value.duration,
            title: value.title as string | null,
          }
        : null
    case 'kick':
      return value.reason === 'kicked' || value.reason === 'room-full'
        ? { version: 1, type: 'kick', reason: value.reason }
        : null
    case 'room-closed':
      return { version: 1, type: 'room-closed' }
    default:
      return null
  }
}

export function encodeMessage(message: Message): string {
  const validated = decodeMessage(message)
  if (!validated) throw new Error('Invalid PartyCast message')
  return JSON.stringify(validated)
}
