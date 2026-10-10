import type { Participant } from './protocol'
import { sanitizeName } from './text'

export type PendingViewer = { peerId: string; name: string }
export type HostSession = { maxViewers: number; viewers: Participant[]; pending: PendingViewer[]; banned: string[]; locked: boolean; closed: boolean }
export type Admission = 'ok' | 'room-full' | 'locked' | 'banned' | 'closed'

export function createHostSession(maxViewers: number): HostSession {
  return { maxViewers: Math.max(1, Math.min(32, Math.floor(maxViewers))), viewers: [], pending: [], banned: [], locked: false, closed: false }
}
export function admission(session: HostSession, peerId: string): Admission {
  if (session.closed) return 'closed'
  if (session.banned.includes(peerId)) return 'banned'
  if (session.locked) return 'locked'
  if (session.viewers.length + session.pending.length >= session.maxViewers) return 'room-full'
  return 'ok'
}
export function requestViewer(session: HostSession, peerId: string, name: string): HostSession {
  if (session.pending.some(p => p.peerId === peerId) || session.viewers.some(p => p.peerId === peerId) || admission(session, peerId) !== 'ok') return session
  return { ...session, pending: [...session.pending, { peerId, name: sanitizeName(name) }] }
}
export function approveViewer(session: HostSession, peerId: string): HostSession {
  const pending = session.pending.find(p => p.peerId === peerId)
  if (!pending || session.closed || session.banned.includes(peerId)) return session
  return { ...session, pending: session.pending.filter(p => p.peerId !== peerId), viewers: [...session.viewers, { ...pending, connection: 'connected' }] }
}
export function removeViewer(session: HostSession, peerId: string, ban = false): HostSession {
  return { ...session, pending: session.pending.filter(p => p.peerId !== peerId), viewers: session.viewers.filter(p => p.peerId !== peerId), banned: ban && !session.banned.includes(peerId) ? [...session.banned, peerId].slice(-512) : session.banned }
}
export function setLocked(session: HostSession, locked: boolean): HostSession { return { ...session, locked } }
export function setViewerConnection(session: HostSession, peerId: string, connection: Participant['connection']): HostSession {
  return { ...session, viewers: session.viewers.map(p => p.peerId === peerId ? { ...p, connection } : p) }
}
export function closeHostSession(session: HostSession): HostSession { return { ...session, closed: true, viewers: [], pending: [] } }
