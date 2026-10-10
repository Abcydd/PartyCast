import { describe, expect, it } from 'vitest'
import { effectiveRelayUrl, validRelayUrl } from './relay-config'
import { defaultSettings, sanitizeSettings } from './settings'

describe('effective relay URL resolver', () => {
  it('prefers a valid configured HTTPS origin and strips a trailing slash', () => {
    expect(effectiveRelayUrl('https://my-relay.example', 'https://baked.example')).toBe('https://my-relay.example')
    expect(effectiveRelayUrl('https://my-relay.example/', 'https://baked.example')).toBe('https://my-relay.example')
  })
  it('falls back to the baked default when nothing valid is configured', () => {
    expect(effectiveRelayUrl('', 'https://baked.example')).toBe('https://baked.example')
    expect(effectiveRelayUrl('   ', 'https://baked.example')).toBe('https://baked.example')
    expect(effectiveRelayUrl(undefined, 'https://baked.example')).toBe('https://baked.example')
    expect(effectiveRelayUrl('http://insecure.example', 'https://baked.example')).toBe('https://baked.example')
    expect(effectiveRelayUrl('https://user:pass@baked.example', 'https://baked.example')).toBe('https://baked.example')
  })
  it('never returns a non-HTTPS URL and never leaks credentials', () => {
    expect(effectiveRelayUrl('http://insecure.example', 'http://also-insecure.example')).toBe('')
    expect(effectiveRelayUrl('', '')).toBe('')
    expect(effectiveRelayUrl(null, undefined)).toBe('')
    expect(effectiveRelayUrl('https://key@x.example', 'https://secret@y.example')).toBe('')
  })
  it('normalizes a baked default with a trailing slash', () => {
    expect(effectiveRelayUrl('', 'https://baked.example/')).toBe('https://baked.example')
  })
  it('is consistent with validRelayUrl', () => {
    expect(validRelayUrl('https://baked.example')).toBe(true)
    expect(validRelayUrl('')).toBe(false)
    expect(validRelayUrl('http://baked.example')).toBe(false)
    expect(validRelayUrl('https://baked.example/path')).toBe(false)
  })
})

describe('relay URL settings without configuration', () => {
  it('defaults to an empty relay URL so the baked default applies', () => {
    expect(defaultSettings.relayUrl).toBe('')
    expect(sanitizeSettings({}).relayUrl).toBe('')
    expect(sanitizeSettings({ relayUrl: 'http://bad' }).relayUrl).toBe('')
    expect(sanitizeSettings({ relayUrl: 'https://relay.example/path' }).relayUrl).toBe('')
    expect(sanitizeSettings({ relayUrl: 'https://relay.example/' }).relayUrl).toBe('https://relay.example')
  })
})
