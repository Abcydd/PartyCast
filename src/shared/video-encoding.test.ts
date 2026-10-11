import { describe, expect, it } from 'vitest'
import { codecPreferenceOrder } from './video-encoding'

const codecs = ['video/VP9', 'video/rtx', 'video/H264', 'video/AV1', 'video/H265', 'video/red', 'video/ulpfec'].map(mimeType => ({ mimeType }))
const names = (items: typeof codecs): string[] => items.map(codec => codec.mimeType)

describe('sender codec ranking', () => {
  it('prefers hardware AV1 and preserves repair codecs after media codecs', () => {
    const order = codecPreferenceOrder(codecs, { AV1: { supported: true, powerEfficient: true } })
    expect(names(order)).toEqual(['video/AV1', 'video/H264', 'video/VP9', 'video/H265', 'video/rtx', 'video/red', 'video/ulpfec'])
  })
  it('prefers hardware HEVC when AV1 has no efficient encoder', () => {
    const order = codecPreferenceOrder(codecs, { AV1: { supported: true, powerEfficient: false }, H265: { supported: true, powerEfficient: true } })
    expect(names(order).slice(0, 4)).toEqual(['video/H265', 'video/H264', 'video/VP9', 'video/AV1'])
  })
  it('falls back to software H264, then VP9 and AV1 when no hardware is efficient', () => {
    const none = { supported: true, powerEfficient: false }
    expect(names(codecPreferenceOrder(codecs, { AV1: none, H265: none, H264: none, VP9: none })).slice(0, 4)).toEqual(['video/H264', 'video/VP9', 'video/AV1', 'video/H265'])
  })
  it('uses H264 first if encoding information is unavailable', () => {
    expect(names(codecPreferenceOrder(codecs)).slice(0, 4)).toEqual(['video/H264', 'video/VP9', 'video/AV1', 'video/H265'])
  })
})
