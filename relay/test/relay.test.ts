import { env } from 'cloudflare:workers'
import worker, { type Env } from '../src/index'
import { describe, expect, it, vi } from 'vitest'
import { proxySfu } from '../src/sfu'

const hostKey = 'test-host-key-long-random-value'
const request = async (path: string, method = 'GET', body?: unknown, token?: string): Promise<Response> => worker.fetch(new Request(`https://relay.test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }), env as Env)
const host = (path: string, method = 'GET', body?: unknown): Promise<Response> => request(path, method, body, hostKey)
async function createRoom(hostPeerId = crypto.randomUUID().replace(/-/g, '')): Promise<{ roomId: string; code: string }> {
  const response = await host('/v1/rooms', 'POST', { hostPeerId, bitrateMbps: 8 })
  expect(response.status).toBe(201)
  return response.json() as Promise<{ roomId: string; code: string }>
}

describe('relay Worker authorization and routes', () => {
  it('forms authenticated SFU calls through a mocked fetch', async () => {
    const mocked = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ sessionId: 'session1' }), { status: 201, headers: { 'content-type': 'application/json' } }))
    expect(await proxySfu('app1', 'secret1', 'POST', '/sessions/new', undefined, mocked)).toEqual({ sessionId: 'session1' })
    expect(mocked).toHaveBeenCalledWith('https://rtc.live.cloudflare.com/v1/apps/app1/sessions/new', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer secret1' }) }))
  })
  it('rejects missing and wrong host auth, unknown routes, oversized and malformed JSON', async () => {
    expect((await request('/v1/rooms', 'POST', { hostPeerId: 'x' })).status).toBe(401)
    expect((await request('/v1/turn', 'POST', {}, 'wrong')).status).toBe(401)
    expect((await host('/v1/unknown')).status).toBe(404)
    expect((await host('/v1/rooms', 'POST', { hostPeerId: 'ok', unwanted: true })).status).toBe(400)
    const huge = await worker.fetch(new Request('https://relay.test/v1/rooms', { method: 'POST', headers: { authorization: `Bearer ${hostKey}` }, body: 'x'.repeat(65537) }), env as Env)
    expect(huge.status).toBe(413)
    const malformed = await worker.fetch(new Request('https://relay.test/v1/rooms', { method: 'POST', headers: { authorization: `Bearer ${hostKey}` }, body: '{' }), env as Env)
    expect(malformed.status).toBe(400)
  })
  it('creates unique codes and supports public by-code lookup', async () => {
    const rooms = await Promise.all(Array.from({ length: 12 }, (_, i) => createRoom(`host${i}`)))
    expect(new Set(rooms.map(r => r.code)).size).toBe(rooms.length)
    const found = await request(`/v1/rooms/by-code/${rooms[0].code.replace('-', '')}`)
    expect(await found.json()).toEqual({ roomId: rooms[0].roomId, hostPeerId: 'host0', mode: 'relay' })
    expect((await request('/v1/rooms/by-code/AAAAAA')).status).toBe(404)
  })
  it('tickets are required and cannot be forged; viewer cannot push or touch host session', async () => {
    const room = await createRoom('pinnedhost')
    const hostSession = await host('/v1/sfu/host/session', 'POST', { roomId: room.roomId })
    const { sessionId: hostSessionId } = await hostSession.json() as { sessionId: string }
    const published = await host('/v1/sfu/host/tracks', 'POST', { roomId: room.roomId, sessionId: hostSessionId, sessionDescription: { type: 'offer', sdp: 'v=0\r\n' }, tracks: [{ location: 'local', mid: '0', trackName: 'video' }] })
    expect(published.status).toBe(200)
    const ticketReply = await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'viewer1' })
    const { ticket } = await ticketReply.json() as { ticket: string }
    const [payload, signature] = ticket.split('.')
    const forged = `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, forged)).status).toBe(401)
    expect((await request('/v1/sfu/host/close', 'POST', { roomId: room.roomId, sessionId: hostSessionId }, ticket)).status).toBe(401)
    const session = await request('/v1/sfu/viewer/session', 'POST', {}, ticket)
    expect(session.status).toBe(200)
    const { sessionId } = await session.json() as { sessionId: string }
    expect((await request('/v1/sfu/viewer/pull', 'POST', { sessionId, tracks: [{ location: 'local' }] }, ticket)).status).toBe(400)
    expect((await request('/v1/sfu/viewer/pull', 'POST', { sessionId: hostSessionId }, ticket)).status).toBe(403)
    const pull = await request('/v1/sfu/viewer/pull', 'POST', { sessionId }, ticket)
    expect(pull.status).toBe(200)
    expect((await pull.json() as { tracks: unknown[] }).tracks).toHaveLength(1)
    expect((await request('/v1/sfu/viewer/close', 'POST', { sessionId }, ticket)).status).toBe(200)
    expect((await host(`/v1/rooms/${room.roomId}/revoke`, 'POST', { viewerId: 'viewer1' })).status).toBe(200)
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, ticket)).status).toBe(401)
    expect((await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'viewer1' })).status).toBe(403)
  })
  it('rejects expired signed tickets', async () => {
    const room = await createRoom('expirehost')
    const root = await crypto.subtle.importKey('raw', new TextEncoder().encode(hostKey), 'HKDF', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('partycast-ticket-v1') }, root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
    const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const payload = encode(new TextEncoder().encode(JSON.stringify({ roomId: room.roomId, viewerId: 'expired', exp: Date.now() - 1 })))
    const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))))
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, `${payload}.${signature}`)).status).toBe(401)
  })
  it('stops issuing tickets when the monthly estimate exceeds its cap', async () => {
    const room = await createRoom('captest')
    const hs = await host('/v1/sfu/host/session', 'POST', { roomId: room.roomId })
    const { sessionId: hostSessionId } = await hs.json() as { sessionId: string }
    await host('/v1/sfu/host/tracks', 'POST', { roomId: room.roomId, sessionId: hostSessionId, sessionDescription: { type: 'offer', sdp: 'v=0' }, tracks: [{ location: 'local', mid: '0', trackName: 'video' }] })
    const ticketResponse = await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'capviewer' })
    const { ticket } = await ticketResponse.json() as { ticket: string }
    const session = await request('/v1/sfu/viewer/session', 'POST', {}, ticket)
    const { sessionId } = await session.json() as { sessionId: string }
    await request('/v1/sfu/viewer/pull', 'POST', { sessionId }, ticket)
    await new Promise(resolve => setTimeout(resolve, 200))
    const heartbeat = await request('/v1/sfu/viewer/heartbeat', 'POST', { sessionId }, ticket)
    expect(await heartbeat.json()).toEqual({ stop: true })
    expect((await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'newviewer' })).status).toBe(429)
    const usage = await host('/v1/usage')
    expect((await usage.json() as { estGB: number }).estGB).toBeGreaterThan(0.0001)
  })
})
