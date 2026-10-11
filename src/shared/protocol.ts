import { sanitizeChat, sanitizeName, sanitizeSubtitleText, sanitizeText } from './text'

export const PROTOCOL_VERSION = 1 as const
export const MAX_MESSAGE_BYTES = 4096
export type Participant = { peerId: string; name: string; connection: 'connecting' | 'connected' | 'failed' }
export type Message =
  | { version: 1; type: 'hello'; name: string; role: 'host' | 'viewer' }
  | { version: 1; type: 'approval'; accepted: boolean; relay?: { roomId: string; ticket: string } }
  | { version: 1; type: 'roster'; participants: Participant[] }
  | { version: 1; type: 'state'; playing: boolean; currentTime: number; duration: number; sentAt: number; title: string | null; relayRevision?: number }
  | { version: 1; type: 'kick'; reason: 'kicked' | 'room-full' | 'denied' | 'locked' | 'banned' | 'monthly-cap' }
  | { version: 1; type: 'room-closed' }
  | { version: 1; type: 'chat'; text: string }
  | { version: 1; type: 'chat-delivery'; senderId: string; text: string; time: number }
  | { version: 1; type: 'subtitle'; text: string | null }
  | { version: 1; type: 'system'; text: string; time: number }
  | { version: 1; type: 'controls-enabled'; enabled: boolean }
  | { version: 1; type: 'control-request'; action: 'play' | 'pause' | 'seek'; currentTime?: number }
  | { version: 1; type: 'quality'; quality: 'auto' | '1080p' | '720p' | '480p' }
  | { version: 1; type: 'quality-enabled'; enabled: boolean }

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const peerId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
export const isViewerAllowedMessage = (m: Message): boolean => m.type === 'hello' && m.role === 'viewer' || m.type === 'chat' || m.type === 'control-request' || m.type === 'quality'
export const isHostAllowedMessage = (m: Message): boolean => !isViewerAllowedMessage(m)

export function decodeMessage(raw: unknown): Message | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!record(v) || v.version !== PROTOCOL_VERSION) return null
  switch (v.type) {
    case 'hello': return bounded(v.name, 32) && sanitizeName(v.name) && (v.role === 'host' || v.role === 'viewer') ? { version: 1, type: 'hello', name: sanitizeName(v.name), role: v.role } : null
    case 'approval': return typeof v.accepted === 'boolean' && (v.relay === undefined || v.accepted && record(v.relay) && Object.keys(v.relay).length === 2 && typeof v.relay.roomId === 'string' && /^[a-f0-9-]{36}$/.test(v.relay.roomId) && typeof v.relay.ticket === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.relay.ticket) && v.relay.ticket.length <= 1024) ? { version: 1, type: 'approval', accepted: v.accepted, ...(v.relay ? { relay: v.relay as { roomId: string; ticket: string } } : {}) } : null
    case 'roster': return Array.isArray(v.participants) && v.participants.length <= 32 && v.participants.every((p: unknown) => record(p) && peerId(p.peerId) && bounded(p.name, 32) && ['connecting','connected','failed'].includes(String(p.connection))) ? { version: 1, type: 'roster', participants: v.participants.map((p: Participant) => ({ ...p, name: sanitizeName(p.name) })) } : null
    case 'state': return typeof v.playing === 'boolean' && time(v.currentTime) && time(v.duration) && time(v.sentAt) && (v.title === null || typeof v.title === 'string' && v.title.length <= 256) && (v.relayRevision === undefined || Number.isSafeInteger(v.relayRevision) && (v.relayRevision as number) >= 0) ? { version: 1, type: 'state', playing: v.playing, currentTime: v.currentTime, duration: v.duration, sentAt: v.sentAt, title: v.title === null ? null : sanitizeText(v.title as string, 256), ...(v.relayRevision === undefined ? {} : { relayRevision: v.relayRevision as number }) } : null
    case 'kick': return ['kicked','room-full','denied','locked','banned','monthly-cap'].includes(String(v.reason)) ? { version: 1, type: 'kick', reason: v.reason as Extract<Message,{type:'kick'}>['reason'] } : null
    case 'room-closed': return { version: 1, type: 'room-closed' }
    case 'chat': return bounded(v.text, 500) && sanitizeChat(v.text) ? { version: 1, type: 'chat', text: sanitizeChat(v.text) } : null
    case 'chat-delivery': return peerId(v.senderId) && bounded(v.text, 500) && time(v.time) ? { version: 1, type: 'chat-delivery', senderId: v.senderId, text: sanitizeChat(v.text), time: v.time } : null
    case 'subtitle': return v.text === null || typeof v.text === 'string' && v.text.length <= 500 ? { version: 1, type: 'subtitle', text: v.text === null ? null : sanitizeSubtitleText(v.text as string) } : null
    case 'system': return bounded(v.text, 500) && time(v.time) ? { version: 1, type: 'system', text: sanitizeText(v.text, 500), time: v.time } : null
    case 'controls-enabled': return typeof v.enabled === 'boolean' ? { version: 1, type: 'controls-enabled', enabled: v.enabled } : null
    case 'quality-enabled': return typeof v.enabled === 'boolean' ? { version: 1, type: 'quality-enabled', enabled: v.enabled } : null
    case 'control-request': return (v.action === 'play' || v.action === 'pause' || v.action === 'seek') && (v.action !== 'seek' ? v.currentTime === undefined : time(v.currentTime)) ? { version: 1, type: 'control-request', action: v.action, ...(v.currentTime === undefined ? {} : { currentTime: v.currentTime as number }) } : null
    case 'quality': return ['auto', '1080p', '720p', '480p'].includes(String(v.quality)) ? { version: 1, type: 'quality', quality: v.quality as Extract<Message,{type:'quality'}>['quality'] } : null
    default: return null
  }
}

export function encodeMessage(message: Message): string {
  const raw = JSON.stringify(message)
  if (!decodeMessage(raw)) throw new Error('Invalid PartyCast message')
  return raw
}
