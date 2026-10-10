import { RELAY_BITRATES, RELAY_HEIGHT, type RelayQuality } from '../../shared/relay-config'
import { codecPreferenceOrder, resolutionScale } from '../../shared/video-encoding'
import type { RelayOperation } from '../../main/relay-ipc'

type Reply = Record<string, unknown>
export class RelayError extends Error { constructor(readonly status: number, readonly reason: string) { super(reason) } }
export async function relayCall(operation: RelayOperation, payload: Record<string, unknown>, ticket?: string): Promise<Reply> {
  const response = await window.partycast.relayCall({ operation, payload, ticket })
  if (response.status < 200 || response.status >= 300) {
    const reason = response.body && typeof response.body === 'object' && 'error' in response.body ? String(response.body.error) : 'relay-error'
    throw new RelayError(response.status, reason)
  }
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) throw new RelayError(502, 'invalid-relay-response')
  return response.body as Reply
}
const description = (v: unknown, type: 'offer' | 'answer'): RTCSessionDescriptionInit => {
  if (!v || typeof v !== 'object' || !('type' in v) || !('sdp' in v) || v.type !== type || typeof v.sdp !== 'string') throw new RelayError(502, 'invalid-sdp')
  return { type, sdp: v.sdp }
}
// Cloudflare TURN hands out UDP, TCP and TLS URLs; Chromium keeps iceGatheringState at 'gathering'
// while the slower TCP/TLS allocations are pending, so waiting for 'complete' alone can stall for
// many seconds. Resolve on 'complete', on the end-of-candidates event, or once candidates have
// stopped arriving for a short settle window.
async function gathered(pc: RTCPeerConnection, settleMs = 600, timeoutMs = 10000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    let candidates = 0
    let settle: ReturnType<typeof setTimeout> | undefined
    const done = (error?: Error): void => {
      clearTimeout(timer); clearTimeout(settle)
      pc.removeEventListener('icegatheringstatechange', change)
      pc.removeEventListener('icecandidate', candidate)
      if (error) reject(error); else resolve()
    }
    const change = (): void => { if (pc.iceGatheringState === 'complete') done() }
    const candidate = (event: RTCPeerConnectionIceEvent): void => {
      if (!event.candidate) { done(); return }
      candidates++
      clearTimeout(settle)
      settle = setTimeout(() => done(), settleMs)
    }
    const timer = setTimeout(() => (candidates > 0 ? done() : done(new Error('ICE gathering timed out'))), timeoutMs)
    pc.addEventListener('icegatheringstatechange', change)
    pc.addEventListener('icecandidate', candidate)
  })
}
// RTCSessionDescription exposes type/sdp as prototype getters, which Electron's structured clone
// drops, so it arrives in the main process as {} — always send a plain object over IPC.
const plainDescription = (pc: RTCPeerConnection): RTCSessionDescriptionInit | null =>
  pc.localDescription ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : null
function prioritizeVideo(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpSender.getCapabilities('video')?.codecs
  if (codecs) try { transceiver.setCodecPreferences(codecPreferenceOrder(codecs)) } catch { /* Browser fallback. */ }
}
async function capVideo(sender: RTCRtpSender, track: MediaStreamTrack, quality: RelayQuality): Promise<void> {
  track.contentHint = 'motion'
  const settings = track.getSettings()
  const height = RELAY_HEIGHT[quality]
  const scale = resolutionScale(settings.width ?? 1920, settings.height ?? height, height === 720 ? 1280 : 1920, height)
  const parameters = sender.getParameters()
  if (!parameters.encodings?.length) parameters.encodings = [{}]
  parameters.encodings[0].maxBitrate = RELAY_BITRATES[quality]
  parameters.encodings[0].scaleResolutionDownBy = scale
  parameters.degradationPreference = 'maintain-framerate'
  try { await sender.setParameters(parameters) } catch { /* Some encoders reject caps. */ }
}

export class RelayPublisher {
  generation = 0
  private pc: RTCPeerConnection | null = null
  private sessionId: string | null = null
  private videoSender: RTCRtpSender | null = null
  private audioSender: RTCRtpSender | null = null
  private streamTask: Promise<void> = Promise.resolve()
  private disposed = false
  private lastBytes = 0
  private lastTimestamp = 0
  constructor(private roomId: string, private iceServers: RTCIceServer[], private quality: RelayQuality) {}
  setStream(stream: MediaStream): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.streamTask = this.streamTask.catch(() => {}).then(() => this.updateStream(stream))
    return this.streamTask
  }
  private async updateStream(stream: MediaStream): Promise<void> {
    if (this.disposed) return
    if (this.pc && this.videoSender && stream.getVideoTracks()[0] && (this.audioSender || !stream.getAudioTracks()[0])) {
      const video = stream.getVideoTracks()[0]
      await this.videoSender.replaceTrack(video)
      await capVideo(this.videoSender, video, this.quality)
      if (this.audioSender) await this.audioSender.replaceTrack(stream.getAudioTracks()[0] ?? null)
      return
    }
    if (this.pc) await this.closeCurrent()
    if (this.disposed) return
    const tracks = stream.getTracks().filter(t => t.kind === 'video' || t.kind === 'audio')
    if (!tracks.length) return
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: 'relay' })
    this.pc = pc
    const transceivers = tracks.map(track => {
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly' })
      if (track.kind === 'video') { this.videoSender = transceiver.sender; prioritizeVideo(transceiver) }
      if (track.kind === 'audio') this.audioSender = transceiver.sender
      return { track, transceiver }
    })
    if (this.videoSender) await capVideo(this.videoSender, tracks.find(t => t.kind === 'video')!, this.quality)
    const session = await relayCall('hostSession', { roomId: this.roomId })
    if (typeof session.sessionId !== 'string') throw new RelayError(502, 'invalid-session')
    this.sessionId = session.sessionId
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc)
    const published = await relayCall('hostTracks', { roomId: this.roomId, sessionId: this.sessionId, sessionDescription: plainDescription(pc), tracks: transceivers.map(({ track, transceiver }) => ({ location: 'local', mid: transceiver.mid, trackName: track.kind })) })
    await pc.setRemoteDescription(description(published.sessionDescription, 'answer'))
    this.generation++
  }
  async setQuality(quality: RelayQuality): Promise<void> {
    this.quality = quality
    const track = this.videoSender?.track
    if (track && this.videoSender) await capVideo(this.videoSender, track, quality)
  }
  async stats(): Promise<string> {
    if (!this.pc) return 'Waiting for video'
    const reports = await this.pc.getStats()
    let codec = 'Negotiating', width = 0, height = 0, bitrate = 0
    reports.forEach(report => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        width = report.frameWidth ?? width; height = report.frameHeight ?? height
        const info = reports.get(report.codecId)
        if (info?.mimeType) codec = String(info.mimeType).replace(/^video\//, '')
        if (this.lastTimestamp && report.timestamp > this.lastTimestamp) bitrate = (report.bytesSent - this.lastBytes) * 8 / (report.timestamp - this.lastTimestamp) / 1000
        this.lastBytes = report.bytesSent; this.lastTimestamp = report.timestamp
      }
    })
    return `${codec} · ${width || '?'}×${height || '?'} · ${bitrate.toFixed(2)} Mbps (${(RELAY_BITRATES[this.quality] / 1_000_000).toFixed(1)} cap)`
  }
  async close(): Promise<void> {
    this.disposed = true
    await this.streamTask.catch(() => {})
    await this.closeCurrent()
  }
  private async closeCurrent(): Promise<void> {
    const id = this.sessionId
    this.sessionId = null
    this.pc?.close(); this.pc = null; this.videoSender = null; this.audioSender = null
    if (id) await relayCall('hostClose', { roomId: this.roomId, sessionId: id }).catch(() => {})
  }
}

export class RelayReceiver {
  private pc: RTCPeerConnection | null = null
  private sessionId: string | null = null
  private pulled = false
  private pulling: Promise<void> | null = null
  private restarting: Promise<void> | null = null
  private stream = new MediaStream()
  constructor(private ticket: string, private onStream: (stream: MediaStream) => void, private onCap: () => void) {}
  pull(): Promise<void> {
    if (this.restarting) return this.restarting
    if (this.pulling) return this.pulling
    this.pulling = this.doPull().finally(() => { this.pulling = null })
    return this.pulling
  }
  private async doPull(): Promise<void> {
    if (this.pulled) return
    if (!this.pc) {
      this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
      this.pc.ontrack = event => { this.stream.addTrack(event.track); this.onStream(this.stream) }
      const session = await relayCall('viewerSession', {}, this.ticket)
      if (typeof session.sessionId !== 'string') throw new RelayError(502, 'invalid-session')
      this.sessionId = session.sessionId
    }
    const pc = this.pc, sessionId = this.sessionId
    if (!pc || !sessionId) return
    const response = await relayCall('viewerPull', { sessionId }, this.ticket)
    await pc.setRemoteDescription(description(response.sessionDescription, 'offer'))
    await pc.setLocalDescription(await pc.createAnswer())
    await gathered(pc)
    await relayCall('viewerRenegotiate', { sessionId, sessionDescription: plainDescription(pc) }, this.ticket)
    this.pulled = true
  }
  async heartbeat(): Promise<void> {
    if (!this.sessionId || !this.pulled) return
    const response = await relayCall('viewerHeartbeat', { sessionId: this.sessionId }, this.ticket)
    if (response.stop === true) { this.onCap(); await this.close() }
  }
  restart(): Promise<void> {
    if (this.restarting) return this.restarting
    this.restarting = (async () => {
      await this.pulling?.catch(() => {})
      await this.closeCurrent()
      await this.doPull()
    })().finally(() => { this.restarting = null })
    return this.restarting
  }
  async close(): Promise<void> {
    await this.restarting?.catch(() => {})
    await this.pulling?.catch(() => {})
    await this.closeCurrent()
  }
  private async closeCurrent(): Promise<void> {
    const id = this.sessionId
    this.sessionId = null; this.pulled = false
    this.pc?.close(); this.pc = null
    for (const track of this.stream.getTracks()) this.stream.removeTrack(track)
    if (id) await relayCall('viewerClose', { sessionId: id }, this.ticket).catch(() => {})
  }
}
