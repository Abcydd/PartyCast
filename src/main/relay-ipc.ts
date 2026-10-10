import { isRoomCode, formatRoomCode } from '../shared/room-code'
import { validRelayUrl } from '../shared/relay-config'

export type RelayOperation =
  | 'lookup' | 'roomCreate' | 'roomHeartbeat' | 'roomClose' | 'ticket' | 'revoke' | 'turn' | 'usage'
  | 'hostSession' | 'hostTracks' | 'hostRenegotiate' | 'hostClose'
  | 'viewerSession' | 'viewerPull' | 'viewerRenegotiate' | 'viewerClose' | 'viewerHeartbeat'
export type RelayCall = { operation: RelayOperation; payload: Record<string, unknown>; ticket?: string }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).every(k => keys.includes(k))
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)
const roomId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v)
const sdp = (v: unknown, type: 'offer' | 'answer'): boolean => obj(v) && exact(v, ['type','sdp']) && v.type === type && typeof v.sdp === 'string' && v.sdp.length > 0 && new TextEncoder().encode(v.sdp).length <= 32768
const ticket = (v: unknown): v is string => typeof v === 'string' && v.length <= 1024 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)
export function relayEndpoint(value: unknown): { path: string; method: 'GET' | 'POST' | 'DELETE'; host: boolean; body?: Record<string, unknown>; ticket?: string } | null {
  if (!obj(value) || !exact(value, ['operation','payload','ticket']) || !obj(value.payload)) return null
  const p = value.payload, op = value.operation
  const viewer = ['viewerSession','viewerPull','viewerRenegotiate','viewerClose','viewerHeartbeat'].includes(String(op))
  if (viewer && !ticket(value.ticket) || !viewer && value.ticket !== undefined) return null
  let path: string, method: 'GET' | 'POST' | 'DELETE' = 'POST', host = !viewer, send: Record<string, unknown> | undefined = p
  switch (op) {
    case 'lookup': if (!exact(p, ['code']) || typeof p.code !== 'string' || !isRoomCode(p.code)) return null; path = `/v1/rooms/by-code/${formatRoomCode(p.code).replace('-', '')}`; method = 'GET'; host = false; send = undefined; break
    case 'roomCreate': if (!exact(p, ['hostPeerId','bitrateMbps']) || !id(p.hostPeerId) || typeof p.bitrateMbps !== 'number' || !Number.isFinite(p.bitrateMbps) || p.bitrateMbps < 0.5 || p.bitrateMbps > 8) return null; path = '/v1/rooms'; break
    case 'roomHeartbeat': if (!roomId(p.roomId) || !exact(p, ['roomId','bitrateMbps']) || typeof p.bitrateMbps !== 'number' || !Number.isFinite(p.bitrateMbps) || p.bitrateMbps < 0.5 || p.bitrateMbps > 8) return null; path = `/v1/rooms/${p.roomId}/heartbeat`; send = { bitrateMbps: p.bitrateMbps }; break
    case 'roomClose': if (!roomId(p.roomId) || !exact(p, ['roomId'])) return null; path = `/v1/rooms/${p.roomId}`; method = 'DELETE'; send = undefined; break
    case 'ticket': if (!roomId(p.roomId) || !id(p.viewerId) || !exact(p, ['roomId','viewerId'])) return null; path = `/v1/rooms/${p.roomId}/tickets`; send = { viewerId: p.viewerId }; break
    case 'revoke': if (!roomId(p.roomId) || !id(p.viewerId) || !exact(p, ['roomId','viewerId'])) return null; path = `/v1/rooms/${p.roomId}/revoke`; send = { viewerId: p.viewerId }; break
    case 'turn': if (!exact(p, [])) return null; path = '/v1/turn'; break
    case 'usage': if (!exact(p, [])) return null; path = '/v1/usage'; method = 'GET'; send = undefined; break
    case 'hostSession': if (!roomId(p.roomId) || !exact(p, ['roomId'])) return null; path = '/v1/sfu/host/session'; break
    case 'hostTracks': if (!roomId(p.roomId) || !id(p.sessionId) || !exact(p, ['roomId','sessionId','tracks','sessionDescription']) || !sdp(p.sessionDescription, 'offer') || !Array.isArray(p.tracks) || p.tracks.length < 1 || p.tracks.length > 2 || !p.tracks.every(t => obj(t) && exact(t, ['location','mid','trackName']) && t.location === 'local' && id(t.mid) && id(t.trackName))) return null; path = '/v1/sfu/host/tracks'; break
    case 'hostRenegotiate': if (!roomId(p.roomId) || !id(p.sessionId) || !exact(p, ['roomId','sessionId','sessionDescription']) || !sdp(p.sessionDescription, 'answer')) return null; path = '/v1/sfu/host/renegotiate'; break
    case 'hostClose': if (!roomId(p.roomId) || !id(p.sessionId) || !exact(p, ['roomId','sessionId'])) return null; path = '/v1/sfu/host/close'; break
    case 'viewerSession': if (!exact(p, [])) return null; path = '/v1/sfu/viewer/session'; break
    case 'viewerPull': if (!id(p.sessionId) || !exact(p, ['sessionId'])) return null; path = '/v1/sfu/viewer/pull'; break
    case 'viewerRenegotiate': if (!id(p.sessionId) || !exact(p, ['sessionId','sessionDescription']) || !sdp(p.sessionDescription, 'answer')) return null; path = '/v1/sfu/viewer/renegotiate'; break
    case 'viewerClose': if (!id(p.sessionId) || !exact(p, ['sessionId'])) return null; path = '/v1/sfu/viewer/close'; break
    case 'viewerHeartbeat': if (!id(p.sessionId) || !exact(p, ['sessionId'])) return null; path = '/v1/sfu/viewer/heartbeat'; break
    default: return null
  }
  return { path, method, host, body: send, ticket: viewer ? value.ticket as string : undefined }
}
export { validRelayUrl }
