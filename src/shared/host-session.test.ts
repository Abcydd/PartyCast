import { describe, expect, it } from 'vitest'
import { admission, approveViewer, closeHostSession, createHostSession, removeViewer, requestViewer, setLocked, setViewerConnection } from './host-session'

describe('host session', () => {
  it('holds a request pending until approved and counts it toward capacity', () => {
    const pending = requestViewer(createHostSession(1), 'a', 'Ada')
    expect(pending.viewers).toHaveLength(0)
    expect(pending.pending).toEqual([{ peerId: 'a', name: 'Ada' }])
    expect(admission(pending, 'b')).toBe('room-full')
    const approved = approveViewer(pending, 'a')
    expect(approved.viewers).toHaveLength(1)
    expect(approved.pending).toHaveLength(0)
    expect(requestViewer(approved, 'a', 'Ada').viewers).toHaveLength(1)
  })
  it('locks, bans, removes, and closes', () => {
    const locked = setLocked(createHostSession(2), true)
    expect(admission(locked, 'a')).toBe('locked')
    const joined = approveViewer(requestViewer(setLocked(locked, false), 'a', 'Ada'), 'a')
    expect(setViewerConnection(joined, 'a', 'failed').viewers[0].connection).toBe('failed')
    const banned = removeViewer(joined, 'a', true)
    expect(admission(banned, 'a')).toBe('banned')
    expect(admission(closeHostSession(banned), 'b')).toBe('closed')
  })
  it('clamps viewer limits', () => {
    expect(createHostSession(0).maxViewers).toBe(1)
    expect(createHostSession(100).maxViewers).toBe(32)
  })
})
