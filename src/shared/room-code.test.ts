import { describe, expect, it } from 'vitest'
import { ROOM_ALPHABET, formatRoomCode, generateRoomCode, isRoomCode, normalizeRoomCode } from './room-code'

describe('room codes', () => {
  it('normalizes case, dash, and spaces', () => {
    expect(normalizeRoomCode(' k7p - q2m ')).toBe('K7PQ2M')
    expect(formatRoomCode('k7pq2m')).toBe('K7P-Q2M')
    expect(isRoomCode('k7p q2m')).toBe(true)
  })
  it('rejects ambiguous and malformed codes', () => {
    for (const code of [
      'O7P-Q2M',
      'I7P-Q2M',
      'L7P-Q2M',
      '07P-Q2M',
      '17P-Q2M',
      'K7P-Q2',
      'K7P-Q2MZ',
      'K7P_Q2M',
    ])
      expect(isRoomCode(code)).toBe(false)
  })
  it('generates six characters in the allowed alphabet', () => {
    const code = generateRoomCode((bytes) => bytes.map((_, index) => index + 2))
    expect(code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/)
    expect([...normalizeRoomCode(code)].every((char) => ROOM_ALPHABET.includes(char))).toBe(true)
  })
})
