import { describe, expect, it } from 'vitest'
import { decodeMessage, encodeMessage, isViewerAllowedMessage, type Message } from './protocol'

describe('control protocol', () => {
  it('round trips every message type', () => {
    const messages: Message[] = [
      { version: 1, type: 'hello', name: 'Ada', role: 'viewer' },
      { version: 1, type: 'roster', participants: [{ peerId: 'p', name: 'Ada', connection: 'connected' }] },
      { version: 1, type: 'state', playing: true, currentTime: 12, duration: 120, sentAt: 123, title: 'movie.mp4' },
      { version: 1, type: 'kick', reason: 'kicked' },
      { version: 1, type: 'room-closed' },
      { version: 1, type: 'approval', accepted: true },
      { version: 1, type: 'chat', text: 'hello' },
      { version: 1, type: 'chat-delivery', senderId: 'p', text: 'hello', time: 123 },
      { version: 1, type: 'subtitle', text: 'hello' },
      { version: 1, type: 'system', text: 'Ada joined', time: 123 },
    ]
    for (const message of messages) expect(decodeMessage(encodeMessage(message))).toEqual(message)
  })
  it('rejects unknown versions, types, and malformed payloads', () => {
    for (const raw of [
      'not json',
      '{}',
      '{"version":2,"type":"room-closed"}',
      '{"version":1,"type":"chat"}',
      '{"version":1,"type":"state","playing":true,"currentTime":-1,"duration":5,"title":null}',
      '{"version":1,"type":"state","playing":true,"currentTime":1,"duration":-5,"sentAt":123,"title":null}',
      '{"version":1,"type":"state","playing":true,"sentAt":123,"title":null}',
      '{"version":1,"type":"state","playing":true,"currentTime":1,"duration":5,"sentAt":-1,"title":null}',
      '{"version":1,"type":"roster","participants":[{"peerId":"x","name":"a","connection":"bogus"}]}',
      '{"version":1,"type":"reaction","emoji":"👍"}',
      'x'.repeat(4097),
    ]) {
      expect(decodeMessage(raw)).toBeNull()
    }
    expect(() => encodeMessage({ version: 1, type: 'hello', name: '', role: 'viewer' })).toThrow()
  })
  it('limits viewer message types and size before parsing', () => {
    expect(isViewerAllowedMessage({ version: 1, type: 'chat', text: 'hi' })).toBe(true)
    expect(isViewerAllowedMessage({ version: 1, type: 'kick', reason: 'kicked' })).toBe(false)
    expect(isViewerAllowedMessage({ version: 1, type: 'roster', participants: [] })).toBe(false)
    expect(decodeMessage(JSON.stringify({ version: 1, type: 'chat', text: '😀'.repeat(2000) }))).toBeNull()
  })
})
