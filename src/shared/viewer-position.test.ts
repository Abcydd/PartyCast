import { describe, expect, it } from 'vitest'
import { viewerPosition } from './viewer-position'

describe('viewer playback position', () => {
  it('interpolates playing state from the host timestamp', () => {
    expect(viewerPosition({ currentTime: 4, duration: 20, playing: true, sentAt: 1000 }, 2500)).toBe(5.5)
  })
  it('keeps paused state still and clamps at duration', () => {
    expect(viewerPosition({ currentTime: 4, duration: 20, playing: false, sentAt: 1000 }, 9000)).toBe(4)
    expect(viewerPosition({ currentTime: 19, duration: 20, playing: true, sentAt: 1000 }, 5000)).toBe(20)
  })
})
