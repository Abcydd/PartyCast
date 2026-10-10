import { describe, expect, it } from 'vitest'
import { parseRangeHeader } from './range'

describe('HTTP byte ranges', () => {
  it('parses a bounded, open, and suffix range', () => {
    expect(parseRangeHeader('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRangeHeader('bytes=-5', 100)).toEqual({ start: 95, end: 99 })
    expect(parseRangeHeader('bytes=90-999', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRangeHeader(null, 100)).toBeNull()
  })
  it('rejects invalid and unsatisfiable ranges', () => {
    for (const header of [
      'bytes=100-',
      'bytes=20-10',
      'bytes=-0',
      'bytes=0-1,4-5',
      'items=0-2',
      'bytes=-',
      'bytes=99999999999999999999-',
    ]) {
      expect(parseRangeHeader(header, 100)).toBe('unsatisfiable')
    }
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable')
  })
})
