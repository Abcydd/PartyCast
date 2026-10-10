import type { Participant } from './protocol'

export type HostSession = { maxViewers: number; viewers: Participant[]; closed: boolean }
export type JoinResult = { session: HostSession; accepted: boolean; reason?: 'room-full' | 'closed' }

export function createHostSession(maxViewers: number): HostSession {
  return { maxViewers: Math.max(1, Math.min(32, Math.floor(maxViewers))), viewers: [], closed: false }
}

export function joinViewer(session: HostSession, peerId: string, name: string): JoinResult {
  if (session.closed) return { session, accepted: false, reason: 'closed' }
  if (session.viewers.some((viewer) => viewer.peerId === peerId)) return { session, accepted: true }
  if (session.viewers.length >= session.maxViewers) return { session, accepted: false, reason: 'room-full' }
  return {
    session: {
      ...session,
      viewers: [...session.viewers, { peerId, name: name.trim().slice(0, 40), connection: 'connected' }],
    },
    accepted: true,
  }
}

export function removeViewer(session: HostSession, peerId: string): HostSession {
  return { ...session, viewers: session.viewers.filter((viewer) => viewer.peerId !== peerId) }
}

export function setViewerConnection(
  session: HostSession,
  peerId: string,
  connection: Participant['connection'],
): HostSession {
  return {
    ...session,
    viewers: session.viewers.map((viewer) => (viewer.peerId === peerId ? { ...viewer, connection } : viewer)),
  }
}

export function closeHostSession(session: HostSession): HostSession {
  return { ...session, closed: true, viewers: [] }
}
