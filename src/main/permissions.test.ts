import { describe, expect, it } from 'vitest'
import { allowAppPermission } from './permissions'

describe('app permission policy', () => {
  it('allows fullscreen only for app contents', () => {
    expect(allowAppPermission(true, 'fullscreen')).toBe(true)
    expect(allowAppPermission(true, 'media')).toBe(false)
    expect(allowAppPermission(true, 'camera')).toBe(false)
    expect(allowAppPermission(false, 'fullscreen')).toBe(false)
  })
})
