import { describe, expect, it } from 'vitest'
import { PeerRateLimiter } from './rate-limit'
import { sanitizeChat, sanitizeName, sanitizeSubtitleText } from './text'
import { parseHandshake } from './handshake'
import { cueAtTime, parseSubtitles } from './subtitles'
import { effectiveQuality, estimatedUploadMbps } from './quality'
import { sanitizeSettings } from './settings'

describe('untrusted input', () => {
  it('limits each peer and records repeated violations', () => {
    const limiter = new PeerRateLimiter()
    for (let i = 0; i < 5; i++) expect(limiter.check('a', 'chat', 1000).allowed).toBe(true)
    expect(limiter.check('a', 'chat', 1000)).toEqual({ allowed: false, violations: 1 })
    expect(limiter.check('a', 'chat', 1000).violations).toBe(2)
    expect(limiter.check('a', 'chat', 1000).violations).toBe(3)
    expect(limiter.check('b', 'chat', 1000).allowed).toBe(true)
    expect(limiter.check('a', 'chat', 6000).allowed).toBe(true)
  })
  it('strips control and bidi overrides, bounds lengths, and keeps Arabic', () => {
    expect(sanitizeName('  أمل\u202E\u2066\u0000  ')).toBe('أمل')
    expect(sanitizeChat('a\nb\u202D')).toBe('ab')
    expect(sanitizeChat('x'.repeat(501))).toHaveLength(500)
    expect(sanitizeSubtitleText('<i>مرحبا</i> {\\an8}world')).toBe('مرحبا world')
  })
  it('accepts exact handshake shapes', () => {
    expect(parseHandshake({ role: 'host', status: 'ok' })).toEqual({ role: 'host', status: 'ok' })
    expect(parseHandshake({ role: 'viewer', status: 'ok' })).toBeNull()
    expect(parseHandshake({ role: 'host', status: 'admin' })).toBeNull()
  })
})

describe('subtitles and quality', () => {
  it('parses SRT, VTT, BOM, CRLF, skips malformed cues, and finds offset cues', () => {
    const srt = parseSubtitles('\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>مرحبا</i> {\\an8}\r\n\r\n2\r\nbad --> 00:00:04,000\r\nwrong')
    expect(srt).toEqual([{ start: 1, end: 2.5, text: 'مرحبا' }])
    expect(cueAtTime(srt, 1.4)?.text).toBe('مرحبا')
    expect(cueAtTime(srt, 1.4, 0.5)).toBeNull()
    expect(cueAtTime(srt, 1.5, 0.5)?.text).toBe('مرحبا')
    expect(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000\n<b>Hello</b>')).toEqual([{ start: 1, end: 2, text: 'Hello' }])
    expect(parseSubtitles('00:00:03,000 --> 00:00:02,000\nno')).toEqual([])
  })
  it('steps auto down when host upload would be exceeded', () => {
    expect(effectiveQuality('auto', 2, 6)).toBe('medium')
    expect(effectiveQuality('auto', 3, 6)).toBe('low')
    expect(effectiveQuality('high', 3, 6)).toBe('high')
    expect(estimatedUploadMbps('low', 3)).toBe(3)
  })
  it('validates privacy, auto-accept, and upload settings', () => {
    expect(sanitizeSettings({ turn: { url: 'turn:relay.example:3478' } }).relayOnly).toBe(true)
    expect(sanitizeSettings({ autoAccept: 'yes', relayOnly: 'yes', uploadMbps: -5 })).toMatchObject({ autoAccept: false, relayOnly: false, uploadMbps: 0.5 })
  })
})
