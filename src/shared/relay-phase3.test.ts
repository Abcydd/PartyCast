import { describe, expect, it } from 'vitest'
import { parseHostKeyFile, validRelayUrl, validateHook } from './relay-config'
import { sanitizeSettings } from './settings'
import { codecPreferenceOrder, resolutionScale, pinnedHostMatches } from './video-encoding'
import { decodeMessage } from './protocol'
import { relayEndpoint } from '../main/relay-ipc'

describe('relay configuration and identity', () => {
  it('imports only explicit URL and key lines', () => {
    expect(parseHostKeyFile('\uFEFFPARTYCAST_RELAY_URL=https://relay.example\r\nPARTYCAST_HOST_KEY=abcdefghijklmnop\r\nOTHER=ignored')).toEqual({ relayUrl: 'https://relay.example', hostKey: 'abcdefghijklmnop' })
    expect(parseHostKeyFile('PARTYCAST_RELAY_URL=http://relay.example\nPARTYCAST_HOST_KEY=abcdefghijklmnop')).toBeNull()
    expect(parseHostKeyFile('PARTYCAST_RELAY_URL=https://relay.example\nPARTYCAST_HOST_KEY=short')).toBeNull()
  })
  it('requires HTTPS and validates hook executable and argument lists', () => {
    expect(validRelayUrl('https://relay.example')).toBe(true)
    expect(validRelayUrl('http://relay.example')).toBe(false)
    expect(validRelayUrl('https://user:pass@relay.example')).toBe(false)
    expect(sanitizeSettings({ relayUrl: 'http://bad' }).relayUrl).toBe('')
    expect(validateHook({ executable: 'C:\\Program Files\\Docker\\docker.exe', args: ['pause', 'restic-restic-1'] })).toEqual({ executable: 'C:\\Program Files\\Docker\\docker.exe', args: ['pause', 'restic-restic-1'] })
    expect(validateHook({ executable: 'docker.exe', args: ['pause'] }).executable).toBe('')
    expect(validateHook({ executable: 'C:\\docker.exe', args: ['bad\narg'] }).args).toEqual([])
  })
  it('pins relay viewers to Worker host ID and validates ticket approval', () => {
    expect(pinnedHostMatches('real', 'real')).toBe(true)
    expect(pinnedHostMatches('fake', 'real')).toBe(false)
    const roomId = '12345678-1234-1234-1234-123456789abc'
    const valid = JSON.stringify({ version: 1, type: 'approval', accepted: true, relay: { roomId, ticket: 'payload.signature' } })
    expect(decodeMessage(valid)).toMatchObject({ type: 'approval', relay: { roomId } })
    expect(decodeMessage(JSON.stringify({ version: 1, type: 'approval', accepted: false, relay: { roomId, ticket: 'payload.signature' } }))).toBeNull()
    expect(decodeMessage(JSON.stringify({ version: 1, type: 'approval', accepted: true, relay: { roomId: '../host', ticket: 'bad' } }))).toBeNull()
    expect(decodeMessage(JSON.stringify({ version: 1, type: 'state', playing: true, currentTime: 0, duration: 10, sentAt: 123, title: 'clip.mp4', relayRevision: 2 }))).toMatchObject({ relayRevision: 2 })
    expect(decodeMessage(JSON.stringify({ version: 1, type: 'state', playing: true, currentTime: 0, duration: 10, sentAt: 123, title: 'clip.mp4', relayRevision: -1 }))).toBeNull()
  })
  it('orders supported video codecs and caps both dimensions', () => {
    const codecs = [{ mimeType: 'video/H264' }, { mimeType: 'video/VP8' }, { mimeType: 'video/VP9' }, { mimeType: 'video/AV1' }]
    expect(codecPreferenceOrder(codecs).map(c => c.mimeType)).toEqual(['video/H264', 'video/VP9', 'video/AV1', 'video/VP8'])
    expect(resolutionScale(3840, 2160)).toBe(2)
    expect(resolutionScale(2560, 1080)).toBeCloseTo(4 / 3)
    expect(resolutionScale(1280, 720)).toBe(1)
    expect(resolutionScale(1920, 1080, 1280, 720)).toBe(1.5)
  })
  it('only accepts allowlisted IPC operations and bounded SDP', () => {
    expect(relayEndpoint({ operation: 'lookup', payload: { code: 'ABC-234' } })?.path).toBe('/v1/rooms/by-code/ABC234')
    expect(relayEndpoint({ operation: 'hostClose', payload: { roomId: '12345678-1234-1234-1234-123456789abc', sessionId: 'viewer-session' } })?.host).toBe(true)
    expect(relayEndpoint({ operation: 'viewerPull', payload: { sessionId: 'a', tracks: [] }, ticket: 'payload.signature' })).toBeNull()
    expect(relayEndpoint({ operation: 'hostTracks', payload: { roomId: '12345678-1234-1234-1234-123456789abc', sessionId: 'host', tracks: [{ location: 'local', mid: '0', trackName: 'video' }], sessionDescription: { type: 'offer', sdp: 'x'.repeat(32769) } } })).toBeNull()
  })
})
