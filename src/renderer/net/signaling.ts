import { joinRoom, selfId } from 'trystero'
import { parseHandshake } from '../../shared/handshake'
import type { Admission } from '../../shared/host-session'
import type { Message } from '../../shared/protocol'
import { decodeMessage, encodeMessage, isHostAllowedMessage, isViewerAllowedMessage } from '../../shared/protocol'
import { effectiveQuality, BITRATES, type EffectiveQuality, type Quality } from '../../shared/quality'
import { PeerRateLimiter } from '../../shared/rate-limit'
import { normalizeRoomCode } from '../../shared/room-code'
import type { Settings } from '../../shared/settings'
import { pinnedHostMatches } from '../../shared/video-encoding'
import { preferredVideoCodecs } from './video-codec'

type Role = 'host' | 'viewer'
export type NetworkOptions = { iceServers?: RTCIceServer[]; relayControl?: boolean; pinnedHostId?: string }
export const localPeerId = (): string => selfId
export type RoomEvents = {
  canJoin?(peerId: string): Admission
  onPeerConnecting?(peerId: string): void
  onPeerRejected?(peerId: string): void
  onPeerJoin?(peerId: string): void
  onPeerLeave?(peerId: string): void
  onPeerState?(peerId: string, state: 'connecting' | 'connected' | 'failed'): void
  onMessage?(message: Message, peerId: string): void
  onStream?(stream: MediaStream, peerId: string): void
  onAbuse?(peerId: string): void
  onError?(reason: 'room-full' | 'locked' | 'banned' | 'connection'): void
}
export type PartyRoom = {
  selfId: string
  send(message: Message, peerId?: string): Promise<void>
  setHostStream(stream: MediaStream | null): Promise<void>
  setQuality(quality: EffectiveQuality): Promise<void>
  stats(): Promise<string>
  approvePeer(peerId: string): Promise<void>
  rejectPeer(peerId: string): void
  leave(): Promise<void>
}

// TURN stays behind this function so a later phase can supply short-lived credentials.
export function iceConfiguration(settings: Settings): RTCConfiguration {
  const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  if (settings.turn.url) iceServers.push({ urls: settings.turn.url, username: settings.turn.username, credential: settings.turn.credential })
  return { iceServers, iceTransportPolicy: settings.relayOnly ? 'relay' : 'all' }
}

export function openPartyRoom(role: Role, code: string, settings: Settings, events: RoomEvents, quality: Quality = 'auto', network: NetworkOptions = {}): PartyRoom {
  const normalized = normalizeRoomCode(code)
  const blocked = new Set<string>()
  const block = (peerId: string): void => {
    blocked.add(peerId)
    if (blocked.size > 512) blocked.delete(blocked.values().next().value!)
  }
  const approved = new Set<string>()
  const connected = new Set<string>()
  const limiter = new PeerRateLimiter()
  let hostId: string | null = null
  let currentStream: MediaStream | null = null
  let currentQuality: EffectiveQuality = effectiveQuality(quality, 0, settings.uploadMbps)
  let mediaTask: Promise<void> = Promise.resolve()
  let closed = false
  let lastBytes = 0, lastTimestamp = 0
  const remoteStream = new MediaStream()
  const codecNegotiationReady = new WeakSet<RTCPeerConnection>()

  const rtcConfig = network.iceServers ? { iceServers: network.iceServers, iceTransportPolicy: role === 'host' && network.relayControl ? 'relay' as const : 'all' as const } : iceConfiguration(settings)
  const room = joinRoom({ appId: 'partycast-v1', password: normalized, rtcConfig }, normalized, {
    handshakeTimeoutMs: 10000,
    onPeerHandshake: async (peerId, send, receive) => {
      events.onPeerConnecting?.(peerId)
      if (role === 'viewer') {
        await send({ role: 'viewer' })
        const reply = parseHandshake((await receive()).data)
        if (!reply || reply.role !== 'host') throw new Error('Not a host')
        if (reply.status !== 'ok') {
          events.onError?.(reply.status === 'full' ? 'room-full' : reply.status)
          throw new Error(reply.status)
        }
        if (!pinnedHostMatches(peerId, network.pinnedHostId ?? null) || hostId && hostId !== peerId) throw new Error('Another host is already connected')
        hostId = peerId
        return
      }
      const request = parseHandshake((await receive()).data)
      if (!request || request.role !== 'viewer' || blocked.has(peerId)) throw new Error('Rejected peer')
      const admission = events.canJoin?.(peerId) ?? 'ok'
      await send({ role: 'host', status: admission === 'room-full' || admission === 'closed' ? 'full' : admission })
      if (admission !== 'ok') throw new Error(admission)
    },
    onJoinError: ({ error, peerId }) => {
      events.onPeerRejected?.(peerId)
      if (role === 'viewer' && !closed && !/full|locked|banned|not a host|another host/i.test(error)) events.onError?.('connection')
    },
  })
  const action = room.makeAction<string>('control-v1')

  function violation(peerId: string): void {
    if (limiter.violate(peerId) >= 3 && role === 'host') {
      events.onAbuse?.(peerId)
      block(peerId)
      room.getPeers()[peerId]?.close()
    }
  }
  action.onMessage = (raw, { peerId }) => {
    if (blocked.has(peerId) || role === 'viewer' && peerId !== hostId) return
    const message = decodeMessage(raw)
    if (!message || role === 'host' && !isViewerAllowedMessage(message) || role === 'viewer' && !isHostAllowedMessage(message)) { violation(peerId); return }
    if (role === 'host' && !approved.has(peerId) && message.type !== 'hello') { violation(peerId); return }
    const category = message.type === 'chat' ? 'chat' : 'other'
    const limit = limiter.check(peerId, category)
    if (!limit.allowed) {
      if (role === 'host' && limit.violations >= 3) { events.onAbuse?.(peerId); block(peerId); room.getPeers()[peerId]?.close() }
      return
    }
    events.onMessage?.(message, peerId)
  }
  room.onPeerJoin = peerId => {
    if (blocked.has(peerId) || role === 'viewer' && hostId !== peerId) { room.getPeers()[peerId]?.close(); return }
    connected.add(peerId)
    const connection = room.getPeers()[peerId]
    if (connection) {
      const report = (): void => {
        const state = connection.connectionState
        events.onPeerState?.(peerId, state === 'failed' || state === 'disconnected' || state === 'closed' ? 'failed' : state === 'connected' ? 'connected' : 'connecting')
      }
      connection.addEventListener('connectionstatechange', report)
      report()
    }
    events.onPeerJoin?.(peerId)
  }
  room.onPeerLeave = peerId => {
    connected.delete(peerId); approved.delete(peerId); limiter.forget(peerId)
    // Pin the first host identity for the lifetime of this viewer room.
    events.onPeerLeave?.(peerId)
  }
  room.onPeerStream = (stream, peerId) => { if (role === 'viewer' && peerId === hostId) events.onStream?.(stream, peerId) }
  room.onPeerTrack = (track, _stream, peerId) => {
    if (role !== 'viewer' || peerId !== hostId) return
    for (const previous of remoteStream.getTracks().filter(item => item.kind === track.kind)) remoteStream.removeTrack(previous)
    remoteStream.addTrack(track)
    events.onStream?.(remoteStream, peerId)
  }

  async function applyBitrate(peerId?: string): Promise<void> {
    for (const [id, connection] of Object.entries(room.getPeers())) {
      if (!approved.has(id) || peerId && id !== peerId) continue
      for (const sender of connection.getSenders()) {
        if (sender.track?.kind !== 'video') continue
        const parameters = sender.getParameters()
        if (!parameters.encodings?.length) parameters.encodings = [{}]
        parameters.encodings[0].maxBitrate = BITRATES[currentQuality]
        try { await sender.setParameters(parameters) } catch { /* Encoder does not support the cap. */ }
      }
    }
  }
  async function prepareCodecNegotiation(pc: RTCPeerConnection): Promise<void> {
    if (codecNegotiationReady.has(pc)) return
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs
    if (!codecs) return
    const preference = await preferredVideoCodecs(codecs)
    const negotiate = pc.onnegotiationneeded
    pc.onnegotiationneeded = event => {
      for (const transceiver of pc.getTransceivers()) if (transceiver.sender.track?.kind === 'video') {
        try { transceiver.setCodecPreferences(preference) } catch (cause) { console.warn('[PartyCast] codec preferences unavailable', cause) }
      }
      negotiate?.call(pc, event)
    }
    codecNegotiationReady.add(pc)
  }
  async function attach(peerId: string): Promise<void> {
    if (!currentStream?.getTracks().length || !room.getPeers()[peerId] || !approved.has(peerId)) return
    const pc = room.getPeers()[peerId]
    const senderTracks = pc.getSenders().map(sender => sender.track)
    await prepareCodecNegotiation(pc)
    for (const track of currentStream.getTracks()) if (!senderTracks.includes(track)) await Promise.all(room.addTrack(track, currentStream, { target: peerId }))
    await applyBitrate(peerId)
  }
  async function updateStream(stream: MediaStream | null): Promise<void> {
    if (role !== 'host' || closed || network.relayControl) return
    currentStream = stream
    for (const peerId of approved) {
      const pc = room.getPeers()[peerId]
      if (!pc) continue
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video' && sender.track?.kind !== 'audio') continue
        const replacement = stream?.getTracks().find(track => track.kind === sender.track?.kind) ?? null
        if (sender.track !== replacement) await sender.replaceTrack(replacement)
      }
      await attach(peerId)
    }
  }
  return {
    selfId,
    async send(message, peerId) {
      if (closed) return
      const raw = encodeMessage(message)
      if (role === 'host') {
        if (peerId) {
          if (!approved.has(peerId) && message.type !== 'approval' && message.type !== 'kick') return
          await action.send(raw, { target: peerId })
        } else for (const id of approved) await action.send(raw, { target: id })
      } else if (hostId && (!peerId || peerId === hostId) && isViewerAllowedMessage(message)) await action.send(raw, { target: hostId })
    },
    setHostStream(stream) { mediaTask = mediaTask.catch(() => {}).then(() => updateStream(stream)); return mediaTask },
    async setQuality(next) { currentQuality = next; await applyBitrate() },
    async stats() {
      const connection = role === 'host'
        ? Object.entries(room.getPeers()).find(([id]) => approved.has(id))?.[1]
        : hostId ? room.getPeers()[hostId] : undefined
      if (!connection) return role === 'host' ? 'Waiting for an approved viewer' : 'Waiting for host media'
      const reports = await connection.getStats()
      let codec = 'Negotiating', width = 0, height = 0, bitrate = 0, audioEnergy = 0
      reports.forEach(report => {
        const mediaReport = role === 'host' ? report.type === 'outbound-rtp' : report.type === 'inbound-rtp'
        if (mediaReport && report.kind === 'video') {
          width = report.frameWidth ?? width; height = report.frameHeight ?? height
          const info = reports.get(report.codecId); if (info?.mimeType) codec = String(info.mimeType).replace(/^video\//, '')
          if (role === 'host' && lastTimestamp && report.timestamp > lastTimestamp) bitrate = (report.bytesSent - lastBytes) * 8 / (report.timestamp - lastTimestamp) / 1000
          if (role === 'host') { lastBytes = report.bytesSent; lastTimestamp = report.timestamp }
        }
        if (role === 'viewer' && report.type === 'inbound-rtp' && report.kind === 'audio') audioEnergy = report.totalAudioEnergy ?? audioEnergy
      })
      const audio = role === 'viewer' ? ` · audio energy ${audioEnergy}` : ''
      return `${codec} · ${width || '?'}×${height || '?'} · ${bitrate.toFixed(2)} Mbps (${(BITRATES[currentQuality] / 1_000_000).toFixed(1)} cap)${audio}`
    },
    async approvePeer(peerId) { if (role !== 'host' || !connected.has(peerId) || blocked.has(peerId)) return; approved.add(peerId); if (!network.relayControl) { await mediaTask; await attach(peerId) } },
    rejectPeer(peerId) { block(peerId); approved.delete(peerId); connected.delete(peerId); room.getPeers()[peerId]?.close() },
    async leave() { closed = true; await room.leave() },
  }
}
