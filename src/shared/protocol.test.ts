import { describe, expect, it } from 'vitest'
import { decodeMessage, encodeMessage, type Message } from './protocol'

describe('control protocol', () => {
  it('round trips every message type', () => {
    const messages: Message[] = [
      { version: 1, type: 'hello', name: 'Ada', role: 'viewer' },
      { version: 1, type: 'roster', participants: [{ peerId: 'p', name: 'Ada', connection: 'connected' }] },
      { version: 1, type: 'state', playing: true, currentTime: 12, duration: 120, title: 'movie.mp4' },
      { version: 1, type: 'kick', reason: 'kicked' },
      { version: 1, type: 'room-closed' },
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
      '{"version":1,"type":"roster","participants":[{"peerId":"x","name":"a","connection":"bogus"}]}',
    ]) {
      expect(decodeMessage(raw)).toBeNull()
    }
    expect(() => encodeMessage({ version: 1, type: 'hello', name: '', role: 'viewer' })).toThrow()
  })
})
