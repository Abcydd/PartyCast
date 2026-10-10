import { env } from 'cloudflare:workers'
import worker, { type Env, advanceTime, resetTime, getSfuCalls, clearSfuCalls, resetFrontLimits } from '../src/index'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { proxySfu } from '../src/sfu'

const hostKey = 'test-host-key-long-random-value'
const wrongHostKey = 'wrong-host-key-long-random-val'

const request = async (
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
  ip = '192.0.2.1'
): Promise<Response> =>
  worker.fetch(
    new Request(`https://relay.test${path}`, {
      method,
      headers: {
        'cf-connecting-ip': ip,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as Env
  )

const host = (path: string, method = 'GET', body?: unknown, ip = '192.0.2.1'): Promise<Response> =>
  request(path, method, body, hostKey, ip)

async function createRoom(hostPeerId = crypto.randomUUID().replace(/-/g, ''), ip = '192.0.2.1'): Promise<{ roomId: string; code: string }> {
  const response = await host('/v1/rooms', 'POST', { hostPeerId, bitrateMbps: 8 }, ip)
  expect(response.status).toBe(201)
  return response.json() as Promise<{ roomId: string; code: string }>
}

async function signTicket(secret: string, payloadObj: { roomId: string; viewerId: string; exp: number }): Promise<string> {
  const root = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('partycast-ticket-v1') },
    root,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign']
  )
  const encode = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = encode(new TextEncoder().encode(JSON.stringify(payloadObj)))
  const sig = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))))
  return `${payload}.${sig}`
}

describe('relay Worker authorization and routes', () => {
  beforeEach(async () => {
    resetTime()
    clearSfuCalls()
    resetFrontLimits()
    await worker.fetch(new Request('https://relay.test/v1/test/reset', { method: 'POST' }), env as Env)
  })

  it('forms authenticated SFU calls through a mocked fetch', async () => {
    const mocked = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ sessionId: 'session1' }), { status: 201, headers: { 'content-type': 'application/json' } }))
    expect(await proxySfu('app1', 'secret1', 'POST', '/sessions/new', undefined, mocked)).toEqual({ sessionId: 'session1' })
    expect(mocked).toHaveBeenCalledWith('https://rtc.live.cloudflare.com/v1/apps/app1/sessions/new', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer secret1' }) }))
  })

  it('missing and wrong host key (401) on every host route', async () => {
    const room = await createRoom('authcheckhost')
    const hostSession = await host('/v1/sfu/host/session', 'POST', { roomId: room.roomId })
    const { sessionId: hostSessionId } = await hostSession.json() as { sessionId: string }

    const hostRoutes: Array<{ path: string; method: string; body?: unknown }> = [
      { path: '/v1/rooms', method: 'POST', body: { hostPeerId: 'peer1' } },
      { path: '/v1/turn', method: 'POST', body: {} },
      { path: '/v1/usage', method: 'GET' },
      { path: `/v1/rooms/${room.roomId}/heartbeat`, method: 'POST', body: { bitrateMbps: 4.5 } },
      { path: `/v1/rooms/${room.roomId}/tickets`, method: 'POST', body: { viewerId: 'viewer_auth' } },
      { path: `/v1/rooms/${room.roomId}/revoke`, method: 'POST', body: { viewerId: 'viewer_auth' } },
      { path: '/v1/sfu/host/session', method: 'POST', body: { roomId: room.roomId } },
      { path: '/v1/sfu/host/tracks', method: 'POST', body: { roomId: room.roomId, sessionId: hostSessionId, sessionDescription: { type: 'offer', sdp: 'v=0' }, tracks: [{ location: 'local', mid: '0', trackName: 'video' }] } },
      { path: '/v1/sfu/host/renegotiate', method: 'POST', body: { roomId: room.roomId, sessionId: hostSessionId, sessionDescription: { type: 'answer', sdp: 'v=0' } } },
      { path: '/v1/sfu/host/close', method: 'POST', body: { roomId: room.roomId, sessionId: hostSessionId } },
      { path: `/v1/rooms/${room.roomId}`, method: 'DELETE' },
    ]

    for (const r of hostRoutes) {
      // 1. Missing host key
      const missing = await request(r.path, r.method, r.body)
      expect(missing.status, `missing auth on ${r.method} ${r.path}`).toBe(401)

      // 2. Short host key
      const short = await request(r.path, r.method, r.body, 'short')
      expect(short.status, `short auth on ${r.method} ${r.path}`).toBe(401)

      // 3. Wrong host key (plausible length)
      const wrong = await request(r.path, r.method, r.body, wrongHostKey)
      expect(wrong.status, `wrong auth on ${r.method} ${r.path}`).toBe(401)
    }
  })

  it('rejects forged ticket, tampered payload, expired ticket, and ticket for another room', async () => {
    const room1 = await createRoom('ticketcheck1')
    const room2 = await createRoom('ticketcheck2')

    const ticketResponse = await host(`/v1/rooms/${room1.roomId}/tickets`, 'POST', { viewerId: 'validviewer' })
    const { ticket } = await ticketResponse.json() as { ticket: string }
    const [payload, signature] = ticket.split('.')

    // 1. Forged signature
    const forged = `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, forged)).status).toBe(401)

    // 2. Tampered payload
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { roomId: string; viewerId: string; exp: number }
    decoded.viewerId = 'hackedviewer'
    const tamperedPayload = btoa(JSON.stringify(decoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const tampered = `${tamperedPayload}.${signature}`
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, tampered)).status).toBe(401)

    // 3. Expired ticket
    const expiredTicket = await signTicket(hostKey, {
      roomId: room1.roomId,
      viewerId: 'expiredviewer',
      exp: Date.now() - 1000,
    })
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, expiredTicket)).status).toBe(401)

    // 4. Ticket for another room (signed with hostKey, but room does not exist in DO or is for wrong room)
    const unknownRoomId = crypto.randomUUID()
    const otherRoomTicket = await signTicket(hostKey, {
      roomId: unknownRoomId,
      viewerId: 'otherroomviewer',
      exp: Date.now() + 3600_000,
    })
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, otherRoomTicket)).status).toBe(401)

    // Valid ticket works
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, ticket)).status).toBe(200)
    // Clean up room2
    await host(`/v1/rooms/${room2.roomId}`, 'DELETE')
  })

  it('viewer cannot call host SFU routes or touch the host session id', async () => {
    const room = await createRoom('isolationtest')
    const hs = await host('/v1/sfu/host/session', 'POST', { roomId: room.roomId })
    const { sessionId: hostSessionId } = await hs.json() as { sessionId: string }

    await host('/v1/sfu/host/tracks', 'POST', {
      roomId: room.roomId,
      sessionId: hostSessionId,
      sessionDescription: { type: 'offer', sdp: 'v=0' },
      tracks: [{ location: 'local', mid: '0', trackName: 'video' }],
    })

    const ticketResponse = await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'iso_viewer' })
    const { ticket } = await ticketResponse.json() as { ticket: string }

    // Viewer cannot call host SFU routes
    expect((await request('/v1/sfu/host/session', 'POST', { roomId: room.roomId }, ticket)).status).toBe(401)
    expect((await request('/v1/sfu/host/tracks', 'POST', { roomId: room.roomId, sessionId: hostSessionId, sessionDescription: { type: 'offer', sdp: 'v=0' }, tracks: [{ location: 'local', mid: '0', trackName: 'video' }] }, ticket)).status).toBe(401)
    expect((await request('/v1/sfu/host/renegotiate', 'POST', { roomId: room.roomId, sessionId: hostSessionId, sessionDescription: { type: 'answer', sdp: 'v=0' } }, ticket)).status).toBe(401)
    expect((await request('/v1/sfu/host/close', 'POST', { roomId: room.roomId, sessionId: hostSessionId }, ticket)).status).toBe(401)

    // Viewer creates their own session
    const vs = await request('/v1/sfu/viewer/session', 'POST', {}, ticket)
    expect(vs.status).toBe(200)

    // Viewer cannot touch host session id in viewer routes
    expect((await request('/v1/sfu/viewer/pull', 'POST', { sessionId: hostSessionId }, ticket)).status).toBe(403)
    expect((await request('/v1/sfu/viewer/renegotiate', 'POST', { sessionId: hostSessionId, sessionDescription: { type: 'answer', sdp: 'v=0' } }, ticket)).status).toBe(403)
    expect((await request('/v1/sfu/viewer/heartbeat', 'POST', { sessionId: hostSessionId }, ticket)).status).toBe(403)
    expect((await request('/v1/sfu/viewer/close', 'POST', { sessionId: hostSessionId }, ticket)).status).toBe(403)
  })

  it('viewer re-pull after revoke → 401', async () => {
    const room = await createRoom('revokerepull')
    const hs = await host('/v1/sfu/host/session', 'POST', { roomId: room.roomId })
    const { sessionId: hostSessionId } = await hs.json() as { sessionId: string }

    await host('/v1/sfu/host/tracks', 'POST', {
      roomId: room.roomId,
      sessionId: hostSessionId,
      sessionDescription: { type: 'offer', sdp: 'v=0' },
      tracks: [{ location: 'local', mid: '0', trackName: 'video' }],
    })

    const ticketResponse = await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'revokev1' })
    const { ticket } = await ticketResponse.json() as { ticket: string }

    const vs = await request('/v1/sfu/viewer/session', 'POST', {}, ticket)
    const { sessionId } = await vs.json() as { sessionId: string }
    const pull1 = await request('/v1/sfu/viewer/pull', 'POST', { sessionId }, ticket)
    expect(pull1.status).toBe(200)

    // Host revokes viewer
    const revoke = await host(`/v1/rooms/${room.roomId}/revoke`, 'POST', { viewerId: 'revokev1' })
    expect(revoke.status).toBe(200)

    // Re-pull or any viewer route after revoke must return 401
    const repull = await request('/v1/sfu/viewer/pull', 'POST', { sessionId }, ticket)
    expect(repull.status).toBe(401)
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, ticket)).status).toBe(401)
  })

  it('inactive viewer gets its tracks closed (assert the mocked SFU close call)', async () => {
    const room = await createRoom('timeoutroom')
    const hs = await host('/v1/sfu/host/session', 'POST', { roomId: room.roomId })
    const { sessionId: hostSessionId } = await hs.json() as { sessionId: string }

    await host('/v1/sfu/host/tracks', 'POST', {
      roomId: room.roomId,
      sessionId: hostSessionId,
      sessionDescription: { type: 'offer', sdp: 'v=0' },
      tracks: [{ location: 'local', mid: '0', trackName: 'video' }],
    })

    const ticketResponse = await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'timeoutviewer' })
    const { ticket } = await ticketResponse.json() as { ticket: string }

    const vs = await request('/v1/sfu/viewer/session', 'POST', {}, ticket)
    const { sessionId } = await vs.json() as { sessionId: string }

    await request('/v1/sfu/viewer/pull', 'POST', { sessionId }, ticket)
    clearSfuCalls()

    // Advance time past 120s inactivity threshold
    advanceTime(130_000)

    // Next request to DO triggers accrue
    await host('/v1/usage')

    // Verify SFU close was called for viewer session
    const calls = getSfuCalls()
    const closeCall = calls.find(c => c.method === 'PUT' && c.path === `/sessions/${sessionId}/tracks/close`)
    expect(closeCall).toBeDefined()
    expect(closeCall?.payload).toEqual({
      tracks: expect.arrayContaining([{ mid: expect.any(String) }]),
      force: true,
    })

    // Calling pull on the invalidated session is rejected
    expect((await request('/v1/sfu/viewer/pull', 'POST', { sessionId }, ticket)).status).toBe(403)
  })

  it('cap reached → new tickets 429 and active viewers tracks closed', async () => {
    const room = await createRoom('capreachedroom')
    const hs = await host('/v1/sfu/host/session', 'POST', { roomId: room.roomId })
    const { sessionId: hostSessionId } = await hs.json() as { sessionId: string }

    await host('/v1/sfu/host/tracks', 'POST', {
      roomId: room.roomId,
      sessionId: hostSessionId,
      sessionDescription: { type: 'offer', sdp: 'v=0' },
      tracks: [{ location: 'local', mid: '0', trackName: 'video' }],
    })

    const ticketResponse = await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'capviewer1' })
    const { ticket } = await ticketResponse.json() as { ticket: string }

    const vs = await request('/v1/sfu/viewer/session', 'POST', {}, ticket)
    const { sessionId } = await vs.json() as { sessionId: string }

    await request('/v1/sfu/viewer/pull', 'POST', { sessionId }, ticket)
    clearSfuCalls()

    // Advance time so egress exceeds cap (MONTHLY_CAP_GB is 0.0001)
    advanceTime(2000)

    // Trigger accrue
    await host('/v1/usage')

    // Assert active viewer's tracks were closed
    const calls = getSfuCalls()
    const capClose = calls.find(c => c.method === 'PUT' && c.path === `/sessions/${sessionId}/tracks/close`)
    expect(capClose).toBeDefined()
    expect(capClose?.payload).toEqual(expect.objectContaining({ force: true }))

    // New tickets return 429
    const newTicketRes = await host(`/v1/rooms/${room.roomId}/tickets`, 'POST', { viewerId: 'capviewer2' })
    expect(newTicketRes.status).toBe(429)

    // Viewer re-pull or new session returns 429
    expect((await request('/v1/sfu/viewer/session', 'POST', {}, ticket)).status).toBe(429)
  })

  it('rejects body > 64 KB with 413', async () => {
    const huge = await worker.fetch(
      new Request('https://relay.test/v1/rooms', {
        method: 'POST',
        headers: { authorization: `Bearer ${hostKey}`, 'content-type': 'application/json' },
        body: 'x'.repeat(65537),
      }),
      env as Env
    )
    expect(huge.status).toBe(413)
  })

  it('rejects oversized SDP with 400', async () => {
    const room = await createRoom('sdproom')
    const hs = await host('/v1/sfu/host/session', 'POST', { roomId: room.roomId })
    const { sessionId: hostSessionId } = await hs.json() as { sessionId: string }

    const oversizedSdp = 'v=0\r\n' + 'a=foo\r\n'.repeat(5000)
    expect(new TextEncoder().encode(oversizedSdp).length).toBeGreaterThan(32768)

    const res = await host('/v1/sfu/host/tracks', 'POST', {
      roomId: room.roomId,
      sessionId: hostSessionId,
      sessionDescription: { type: 'offer', sdp: oversizedSdp },
      tracks: [{ location: 'local', mid: '0', trackName: 'video' }],
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 on unknown routes', async () => {
    expect((await host('/v1/unknown')).status).toBe(404)
    expect((await request('/v1/unknown')).status).toBe(404)
    expect((await request('/v1/sfu/unknown')).status).toBe(404)
  })

  it('by-code lookup for a deleted or expired room → 404', async () => {
    // 1. Deleted room
    const roomDel = await createRoom('tobedeleted')
    const codeDel = roomDel.code.replace('-', '')
    expect((await request(`/v1/rooms/by-code/${codeDel}`)).status).toBe(200)

    const delRes = await host(`/v1/rooms/${roomDel.roomId}`, 'DELETE')
    expect(delRes.status).toBe(200)
    expect((await request(`/v1/rooms/by-code/${codeDel}`)).status).toBe(404)

    // 2. Expired room
    const roomExp = await createRoom('tobeexpired')
    const codeExp = roomExp.code.replace('-', '')
    expect((await request(`/v1/rooms/by-code/${codeExp}`)).status).toBe(200)

    // Advance time past 12 hour expiry
    advanceTime(13 * 3600_000)
    expect((await request(`/v1/rooms/by-code/${codeExp}`)).status).toBe(404)
  })

  it('code uniqueness across multiple room creations', async () => {
    // Distinct client IPs so this test exercises code uniqueness, not the per-IP rate limiter.
    const rooms = await Promise.all(Array.from({ length: 30 }, (_, i) => createRoom(`uniquehost${i}`, `203.0.113.${i + 1}`)))
    const codes = rooms.map(r => r.code)
    expect(new Set(codes).size).toBe(30)
    expect(codes.every(c => /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(c))).toBe(true)
  })

  it('rate limits unauthenticated by-code lookups in the front Worker', async () => {
    const code = 'ABC234'
    const ip = '198.51.100.99'

    // First 30 lookups are allowed through
    for (let i = 0; i < 30; i++) {
      const res = await request(`/v1/rooms/by-code/${code}`, 'GET', undefined, undefined, ip)
      expect(res.status).not.toBe(429)
    }

    // 31st request exceeds the 30/60s rate limit in the front Worker
    const limited = await request(`/v1/rooms/by-code/${code}`, 'GET', undefined, undefined, ip)
    expect(limited.status).toBe(429)
  })
})
