import { proxySfu } from './sfu'

export interface Env {
  RELAY_STATE: DurableObjectNamespace
  TURN_KEY_ID: string
  TURN_API_TOKEN: string
  SFU_APP_ID: string
  SFU_APP_SECRET: string
  HOST_KEY: string
  MONTHLY_CAP_GB?: string
  MOCK_SFU?: string
}

type Viewer = { sessionId?: string; mids: string[]; last: number; active: boolean }
type Room = { id: string; code: string; hostPeerId: string; expires: number; bitrateMbps: number; hostSessionId?: string; hostTracks: { mid: string; trackName: string }[]; viewers: Record<string, Viewer>; revoked: string[] }
type Data = { rooms: Record<string, Room>; month: string; estGB: number }
const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const error = (reason: string, status: number): Response => json({ error: reason }, status)
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).every(k => keys.includes(k))
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)
const roomId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v)
const sdp = (v: unknown, type: 'offer' | 'answer'): v is { type: typeof type; sdp: string } => obj(v) && exact(v, ['type', 'sdp']) && v.type === type && typeof v.sdp === 'string' && v.sdp.length > 0 && new TextEncoder().encode(v.sdp).length <= 32768
const mid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-zA-Z_-]{1,16}$/.test(v)

async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') ?? 0) > 65536) throw new HttpError('body-too-large', 413)
  const reader = request.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 65536) { await reader.cancel(); throw new HttpError('body-too-large', 413) }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new HttpError('invalid-json', 400) }
  if (!obj(parsed)) throw new HttpError('invalid-body', 400)
  return parsed
}
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message) } }

async function constantTimeEqual(actual: string, expected: string): Promise<boolean> {
  const digest = async (s: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  const a = await digest(actual), b = await digest(expected)
  let diff = actual.length ^ expected.length
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
const bearer = (r: Request): string => /^Bearer (.+)$/.exec(r.headers.get('authorization') ?? '')?.[1] ?? ''
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (value: string): Uint8Array => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0))
async function ticketKey(secret: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('partycast-ticket-v1') }, root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
}
async function issueTicket(secret: string, room: Room, viewerId: string): Promise<string> {
  const payload = b64(new TextEncoder().encode(JSON.stringify({ roomId: room.id, viewerId, exp: Date.now() + 8 * 3600_000 })))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await ticketKey(secret), new TextEncoder().encode(payload)))
  return `${payload}.${b64(sig)}`
}
async function verifyTicket(secret: string, raw: string): Promise<{ roomId: string; viewerId: string } | null> {
  try {
    if (raw.length > 1024) return null
    const [payload, signature, extra] = raw.split('.')
    if (!payload || !signature || extra) return null
    const value: unknown = JSON.parse(new TextDecoder().decode(unb64(payload)))
    if (!obj(value) || !exact(value, ['roomId', 'viewerId', 'exp']) || !roomId(value.roomId) || !id(value.viewerId) || typeof value.exp !== 'number' || !Number.isInteger(value.exp) || value.exp <= Date.now() || value.exp > Date.now() + 8 * 3600_000) return null
    if (!await crypto.subtle.verify('HMAC', await ticketKey(secret), unb64(signature) as BufferSource, new TextEncoder().encode(payload))) return null
    return { roomId: value.roomId, viewerId: value.viewerId }
  } catch { return null }
}
function code(): string {
  let result = ''
  const limit = Math.floor(256 / alphabet.length) * alphabet.length
  while (result.length < 6) for (const byte of crypto.getRandomValues(new Uint8Array(8))) { if (byte < limit) result += alphabet[byte % alphabet.length]; if (result.length === 6) break }
  return `${result.slice(0, 3)}-${result.slice(3)}`
}

export class RelayState {
  private limits = new Map<string, { count: number; until: number }>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private state: DurableObjectState, private env: Env) {}
  private async data(): Promise<Data> { return await this.state.storage.get<Data>('data') ?? { rooms: {}, month: new Date().toISOString().slice(0, 7), estGB: 0 } }
  private cap(): number { const n = Number(this.env.MONTHLY_CAP_GB ?? 900); return Number.isFinite(n) && n > 0 ? n : 900 }
  private accrue(data: Data): void {
    const now = Date.now(), month = new Date(now).toISOString().slice(0, 7)
    if (data.month !== month) { data.month = month; data.estGB = 0 }
    for (const room of Object.values(data.rooms)) {
      if (room.expires <= now) { delete data.rooms[room.id]; continue }
      for (const viewer of Object.values(room.viewers)) {
        if (!viewer.active) continue
        const elapsed = Math.max(0, now - viewer.last)
        data.estGB += room.bitrateMbps * Math.min(elapsed, 120000) / 1000 / 8 / 1000
        viewer.last = now
        if (elapsed > 120000) viewer.active = false
      }
    }
  }
  private limit(request: Request): void {
    const key = request.headers.get('cf-connecting-ip') ?? 'local'
    const now = Date.now(), item = this.limits.get(key)
    const next = !item || item.until <= now ? { count: 1, until: now + 60_000 } : { count: item.count + 1, until: item.until }
    this.limits.set(key, next)
    if (this.limits.size > 5000) this.limits.clear()
    if (next.count > 120) throw new HttpError('rate-limit', 429)
  }
  private async sfu(method: string, path: string, payload?: unknown): Promise<Record<string, unknown>> {
    if (this.env.MOCK_SFU === '1') {
      if (path.endsWith('/sessions/new')) return { sessionId: crypto.randomUUID() }
      if (path.endsWith('/tracks/new')) return { sessionDescription: { type: payload && obj(payload) && sdp(payload.sessionDescription, 'offer') ? 'answer' : 'offer', sdp: 'v=0\r\n' }, tracks: obj(payload) ? payload.tracks : [] }
      return { tracks: [] }
    }
    try { return await proxySfu(this.env.SFU_APP_ID, this.env.SFU_APP_SECRET, method, path, payload) }
    catch { throw new HttpError('sfu-error', 502) }
  }
  fetch(request: Request): Promise<Response> {
    const result = this.queue.then(() => this.handle(request))
    this.queue = result.catch(() => {})
    return result
  }
  private async handle(request: Request): Promise<Response> {
    try {
      this.limit(request)
      const url = new URL(request.url), path = url.pathname, method = request.method
      const data = await this.data()
      this.accrue(data)
      const host = async (): Promise<void> => { if (!this.env.HOST_KEY || !await constantTimeEqual(bearer(request), this.env.HOST_KEY)) throw new HttpError('unauthorized', 401) }
      const viewer = async (): Promise<{ room: Room; viewerId: string; record: Viewer }> => {
        const claim = await verifyTicket(this.env.HOST_KEY, bearer(request))
        const room = claim && data.rooms[claim.roomId]
        if (!claim || !room || room.revoked.includes(claim.viewerId)) throw new HttpError('unauthorized', 401)
        return { room, viewerId: claim.viewerId, record: room.viewers[claim.viewerId] ??= { mids: [], last: 0, active: false } }
      }
      let result: Response
      if (method === 'POST' && path === '/v1/rooms') {
        await host()
        const b = await body(request)
        if (!exact(b, ['hostPeerId', 'bitrateMbps']) || !id(b.hostPeerId) || b.bitrateMbps !== undefined && (typeof b.bitrateMbps !== 'number' || !Number.isFinite(b.bitrateMbps) || b.bitrateMbps < 0.5 || b.bitrateMbps > 8)) throw new HttpError('invalid-body', 400)
        let next = code()
        while (Object.values(data.rooms).some(r => r.code === next)) next = code()
        const room: Room = { id: crypto.randomUUID(), code: next, hostPeerId: b.hostPeerId, expires: Date.now() + 12 * 3600_000, bitrateMbps: typeof b.bitrateMbps === 'number' ? b.bitrateMbps : 4.5, hostTracks: [], viewers: {}, revoked: [] }
        data.rooms[room.id] = room
        result = json({ roomId: room.id, code: room.code }, 201)
      } else if (method === 'GET' && /^\/v1\/rooms\/by-code\/[A-Z2-9-]{6,7}$/.test(path)) {
        const search = path.split('/').at(-1)?.replace('-', '')
        const room = Object.values(data.rooms).find(r => r.code.replace('-', '') === search)
        result = room ? json({ roomId: room.id, hostPeerId: room.hostPeerId, mode: 'relay' }) : error('not-found', 404)
      } else if (path === '/v1/turn' && method === 'POST') {
        await host()
        const b = await body(request)
        if (!exact(b, [])) throw new HttpError('invalid-body', 400)
        if (this.env.MOCK_SFU === '1') result = json({ iceServers: [{ urls: 'turn:127.0.0.1:3478', username: 'dummy', credential: 'dummy' }] })
        else {
          const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_ID)}/credentials/generate-ice-servers`, { method: 'POST', headers: { authorization: `Bearer ${this.env.TURN_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 3600 }) })
          const value: unknown = await response.json()
          if (!response.ok || !obj(value) || !Array.isArray(value.iceServers)) throw new HttpError('turn-error', 502)
          result = json({ iceServers: value.iceServers })
        }
      } else if (path === '/v1/usage' && method === 'GET') {
        await host(); result = json({ month: data.month, estGB: data.estGB, capGB: this.cap() })
      } else if (/^\/v1\/rooms\/[a-f0-9-]{36}(\/heartbeat|\/tickets|\/revoke)?$/.test(path)) {
        await host()
        const parts = path.split('/'), room = data.rooms[parts[3]]
        if (!room) throw new HttpError('not-found', 404)
        if (method === 'POST' && parts[4] === 'heartbeat') {
          const b = await body(request)
          if (!exact(b, ['bitrateMbps']) || b.bitrateMbps !== undefined && (typeof b.bitrateMbps !== 'number' || !Number.isFinite(b.bitrateMbps) || b.bitrateMbps < 0.5 || b.bitrateMbps > 8)) throw new HttpError('invalid-body', 400)
          room.expires = Date.now() + 12 * 3600_000
          if (typeof b.bitrateMbps === 'number') room.bitrateMbps = b.bitrateMbps
          result = json({ ok: true })
        } else if (method === 'POST' && parts[4] === 'tickets') {
          const b = await body(request)
          if (!exact(b, ['viewerId']) || !id(b.viewerId)) throw new HttpError('invalid-body', 400)
          if (room.revoked.includes(b.viewerId)) throw new HttpError('revoked', 403)
          if (data.estGB >= this.cap()) throw new HttpError('monthly-cap', 429)
          result = json({ ticket: await issueTicket(this.env.HOST_KEY, room, b.viewerId) })
        } else if (method === 'POST' && parts[4] === 'revoke') {
          const b = await body(request)
          if (!exact(b, ['viewerId']) || !id(b.viewerId)) throw new HttpError('invalid-body', 400)
          if (!room.revoked.includes(b.viewerId)) room.revoked.push(b.viewerId)
          const record = room.viewers[b.viewerId]
          if (record) {
            if (record.sessionId && record.mids.length) await this.sfu('PUT', `/sessions/${record.sessionId}/tracks/close`, { tracks: record.mids.map(mid => ({ mid })), force: true }).catch(() => {})
            record.active = false; record.sessionId = undefined; record.mids = []
          }
          result = json({ revoked: true })
        } else if (method === 'DELETE' && parts.length === 4) {
          delete data.rooms[room.id]; result = json({ closed: true })
        } else result = error('not-found', 404)
      } else if (method === 'POST' && /^\/v1\/sfu\/host\/(session|tracks|renegotiate|close)$/.test(path)) {
        await host()
        const b = await body(request)
        const room = roomId(b.roomId) ? data.rooms[b.roomId] : undefined
        if (!room) throw new HttpError('not-found', 404)
        const action = path.split('/').at(-1)
        if (action === 'session') {
          if (!exact(b, ['roomId']) || room.hostSessionId) throw new HttpError('invalid-body', 400)
          const created = await this.sfu('POST', '/sessions/new')
          if (!id(created.sessionId)) throw new HttpError('sfu-error', 502)
          room.hostSessionId = created.sessionId; result = json(created)
        } else {
          if (!room.hostSessionId || b.sessionId !== room.hostSessionId) throw new HttpError('forbidden-session', 403)
          if (action === 'tracks') {
            if (!exact(b, ['roomId','sessionId','tracks','sessionDescription']) || !sdp(b.sessionDescription, 'offer') || !Array.isArray(b.tracks) || b.tracks.length < 1 || b.tracks.length > 2 || !b.tracks.every(t => obj(t) && exact(t, ['location','mid','trackName']) && t.location === 'local' && mid(t.mid) && id(t.trackName))) throw new HttpError('invalid-body', 400)
            const response = await this.sfu('POST', `/sessions/${room.hostSessionId}/tracks/new`, { sessionDescription: b.sessionDescription, tracks: b.tracks })
            room.hostTracks = (b.tracks as { mid: string; trackName: string }[]).map(t => ({ mid: t.mid, trackName: t.trackName }))
            result = json(response)
          } else if (action === 'renegotiate') {
            if (!exact(b, ['roomId','sessionId','sessionDescription']) || !sdp(b.sessionDescription, 'answer')) throw new HttpError('invalid-body', 400)
            result = json(await this.sfu('PUT', `/sessions/${room.hostSessionId}/renegotiate`, { sessionDescription: b.sessionDescription }))
          } else if (action === 'close') {
            if (!exact(b, ['roomId','sessionId'])) throw new HttpError('invalid-body', 400)
            const tracks = room.hostTracks.map(t => ({ mid: t.mid }))
            if (tracks.length) await this.sfu('PUT', `/sessions/${room.hostSessionId}/tracks/close`, { tracks, force: true })
            room.hostTracks = []; room.hostSessionId = undefined
            result = json({ closed: true })
          } else result = error('not-found', 404)
        }
      } else if (method === 'POST' && /^\/v1\/sfu\/viewer\/(session|pull|renegotiate|close|heartbeat)$/.test(path)) {
        const { room, record } = await viewer()
        const b = await body(request), action = path.split('/').at(-1)
        if (action === 'session') {
          if (!exact(b, []) || record.sessionId) throw new HttpError('invalid-body', 400)
          const created = await this.sfu('POST', '/sessions/new')
          if (!id(created.sessionId)) throw new HttpError('sfu-error', 502)
          record.sessionId = created.sessionId; result = json(created)
        } else {
          if (!record.sessionId || b.sessionId !== record.sessionId) throw new HttpError('forbidden-session', 403)
          if (action === 'pull') {
            if (!exact(b, ['sessionId'])) throw new HttpError('invalid-body', 400)
            if (!room.hostSessionId || !room.hostTracks.length) throw new HttpError('no-host-tracks', 409)
            const tracks = room.hostTracks.map(t => ({ location: 'remote', sessionId: room.hostSessionId, trackName: t.trackName }))
            const response = await this.sfu('POST', `/sessions/${record.sessionId}/tracks/new`, { tracks })
            record.mids = Array.isArray(response.tracks) ? response.tracks.filter(obj).map(t => t.mid).filter(mid) : []
            record.active = true; record.last = Date.now()
            result = json(response)
          } else if (action === 'renegotiate') {
            if (!exact(b, ['sessionId','sessionDescription']) || !sdp(b.sessionDescription, 'answer')) throw new HttpError('invalid-body', 400)
            result = json(await this.sfu('PUT', `/sessions/${record.sessionId}/renegotiate`, { sessionDescription: b.sessionDescription }))
          } else if (action === 'heartbeat') {
            if (!exact(b, ['sessionId'])) throw new HttpError('invalid-body', 400)
            record.active = data.estGB < this.cap(); record.last = Date.now()
            result = json({ stop: !record.active })
          } else if (action === 'close') {
            if (!exact(b, ['sessionId'])) throw new HttpError('invalid-body', 400)
            if (record.mids.length) await this.sfu('PUT', `/sessions/${record.sessionId}/tracks/close`, { tracks: record.mids.map(mid => ({ mid })), force: true })
            record.active = false; record.sessionId = undefined; record.mids = []
            result = json({ closed: true })
          } else result = error('not-found', 404)
        }
      } else result = error('not-found', 404)
      await this.state.storage.put('data', data)
      return result
    } catch (cause) {
      if (cause instanceof HttpError) return error(cause.message, cause.status)
      return error('internal-error', 500)
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.RELAY_STATE.get(env.RELAY_STATE.idFromName('global'))
    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>
