import { joinRoom } from 'trystero'
import type { Message } from '../../shared/protocol'
import { decodeMessage, encodeMessage } from '../../shared/protocol'
import { normalizeRoomCode } from '../../shared/room-code'
import type { Settings } from '../../shared/settings'

export type Quality = 'low' | 'medium' | 'high' | 'source'
export const BITRATES: Record<Quality, number> = {
  low: 1_000_000,
  medium: 2_500_000,
  high: 5_000_000,
  source: 8_000_000,
}

type Role = 'host' | 'viewer'
type Handshake = { role: Role; status?: 'ok' | 'full' }
export type RoomEvents = {
  onPeerConnecting?(peerId: string): void
  onPeerJoin?(peerId: string): void
  onPeerLeave?(peerId: string): void
  onPeerState?(peerId: string, state: 'connecting' | 'connected' | 'failed'): void
  onMessage?(message: Message, peerId: string): void
  onStream?(stream: MediaStream, peerId: string): void
  onError?(reason: 'room-full' | 'connection'): void
}

export type PartyRoom = {
  send(message: Message, peerId?: string): Promise<void>
  setHostStream(stream: MediaStream | null): Promise<void>
  setQuality(quality: Quality): Promise<void>
  rejectPeer(peerId: string): void
  leave(): Promise<void>
}

export function openPartyRoom(
  role: Role,
  code: string,
  settings: Settings,
  events: RoomEvents,
  quality: Quality = 'medium',
): PartyRoom {
  const normalized = normalizeRoomCode(code)
  const blocked = new Set<string>()
  const pending = new Set<string>()
  const connected = new Set<string>()
  let hostId: string | null = null
  let currentStream: MediaStream | null = null
  let sentTracks: MediaStreamTrack[] = []
  let currentQuality = quality
  let mediaTask: Promise<void> = Promise.resolve()
  let closed = false
  const remoteStream = new MediaStream()
  const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  if (settings.turn.url)
    iceServers.push({
      urls: settings.turn.url,
      username: settings.turn.username,
      credential: settings.turn.credential,
    })

  const room = joinRoom(
    {
      appId: 'partycast-v1',
      password: normalized,
      rtcConfig: { iceServers },
    },
    normalized,
    {
      handshakeTimeoutMs: 10000,
      onPeerHandshake: async (peerId, send, receive) => {
        events.onPeerConnecting?.(peerId)
        if (role === 'viewer') {
          await send({ role: 'viewer' })
          const reply = (await receive()).data as Handshake
          if (reply?.role !== 'host') throw new Error('Not a host')
          if (reply.status === 'full') {
            events.onError?.('room-full')
            throw new Error('Room full')
          }
          if (hostId && hostId !== peerId) throw new Error('Another host is already connected')
          hostId = peerId
          return
        }
        const request = (await receive()).data as Handshake
        if (request?.role !== 'viewer' || blocked.has(peerId)) throw new Error('Rejected peer')
        if (connected.size + pending.size >= settings.maxViewers) {
          await send({ role: 'host', status: 'full' })
          throw new Error('Room full')
        }
        pending.add(peerId)
        await send({ role: 'host', status: 'ok' })
      },
      onJoinError: ({ error, peerId }) => {
        pending.delete(peerId)
        if (role === 'viewer' && !closed && !/room full|not a host|another host/i.test(error))
          events.onError?.('connection')
      },
    },
  )

  const action = room.makeAction<string>('control-v1')
  action.onMessage = (raw, { peerId }) => {
    if (blocked.has(peerId) || (role === 'viewer' && peerId !== hostId)) return
    const message = decodeMessage(raw)
    if (message) events.onMessage?.(message, peerId)
  }
  room.onPeerJoin = (peerId) => {
    pending.delete(peerId)
    if (blocked.has(peerId) || (role === 'viewer' && hostId !== peerId)) {
      room.getPeers()[peerId]?.close()
      return
    }
    connected.add(peerId)
    const connection = room.getPeers()[peerId]
    if (connection) {
      const reportState = (): void => {
        const state = connection.connectionState
        events.onPeerState?.(
          peerId,
          state === 'failed' || state === 'disconnected' || state === 'closed'
            ? 'failed'
            : state === 'connected'
              ? 'connected'
              : 'connecting',
        )
      }
      connection.addEventListener('connectionstatechange', reportState)
      reportState()
    }
    events.onPeerJoin?.(peerId)
    if (role === 'host')
      void mediaTask
        .then(async () => {
          const peerConnection = room.getPeers()[peerId]
          if (!currentStream?.getTracks().length || !peerConnection) return
          const senderTracks = peerConnection.getSenders().map((sender) => sender.track)
          const missing = currentStream.getTracks().filter((track) => !senderTracks.includes(track))
          await Promise.all(
            missing.flatMap((track) => room.addTrack(track, currentStream!, { target: peerId })),
          )
          await applyBitrate(peerId)
        })
        .catch(() => events.onError?.('connection'))
  }
  room.onPeerLeave = (peerId) => {
    pending.delete(peerId)
    connected.delete(peerId)
    if (hostId === peerId) hostId = null
    events.onPeerLeave?.(peerId)
  }
  room.onPeerStream = (stream, peerId) => {
    if (role === 'viewer' && peerId === hostId) events.onStream?.(stream, peerId)
  }
  room.onPeerTrack = (track, _stream, peerId) => {
    if (role !== 'viewer' || peerId !== hostId) return
    for (const previous of remoteStream.getTracks().filter((item) => item.kind === track.kind))
      remoteStream.removeTrack(previous)
    remoteStream.addTrack(track)
    events.onStream?.(remoteStream, peerId)
  }

  async function applyBitrate(peerId?: string): Promise<void> {
    for (const [id, connection] of Object.entries(room.getPeers())) {
      if (peerId && id !== peerId) continue
      for (const sender of connection.getSenders()) {
        if (sender.track?.kind !== 'video') continue
        const parameters = sender.getParameters()
        if (!parameters.encodings?.length) parameters.encodings = [{}]
        parameters.encodings[0].maxBitrate = BITRATES[currentQuality]
        try {
          await sender.setParameters(parameters)
        } catch {
          /* Some encoders do not support a cap. */
        }
      }
    }
  }

  async function updateHostStream(stream: MediaStream | null): Promise<void> {
    if (role !== 'host' || closed) return
    const previous = currentStream
    currentStream = stream
    if (!stream || !stream.getTracks().length) {
      if (previous) room.removeStream(previous)
      sentTracks = []
      return
    }
    const nextTracks = stream.getTracks()
    if (!previous || !sentTracks.length) {
      await Promise.all(room.addStream(stream))
    } else {
      for (const kind of ['video', 'audio']) {
        const oldTrack = sentTracks.find((track) => track.kind === kind)
        const newTrack = nextTracks.find((track) => track.kind === kind)
        if (oldTrack && newTrack && oldTrack !== newTrack)
          await Promise.all(room.replaceTrack(oldTrack, newTrack))
        else if (oldTrack && !newTrack) room.removeTrack(oldTrack)
        else if (!oldTrack && newTrack) await Promise.all(room.addTrack(newTrack, stream))
      }
    }
    sentTracks = nextTracks
    await applyBitrate()
  }

  return {
    async send(message, peerId) {
      if (closed) return
      await action.send(encodeMessage(message), { target: peerId ?? null })
    },
    setHostStream(stream) {
      mediaTask = mediaTask.catch(() => {}).then(() => updateHostStream(stream))
      return mediaTask
    },
    async setQuality(next) {
      currentQuality = next
      await applyBitrate()
    },
    rejectPeer(peerId) {
      blocked.add(peerId)
      pending.delete(peerId)
      connected.delete(peerId)
      room.getPeers()[peerId]?.close()
    },
    async leave() {
      closed = true
      await room.leave()
    },
  }
}
