import { describe, expect, it } from 'vitest'
import {
  closeHostSession,
  createHostSession,
  joinViewer,
  removeViewer,
  setViewerConnection,
} from './host-session'

describe('host session', () => {
  it('admits only max viewers and does not duplicate peers', () => {
    const first = joinViewer(createHostSession(1), 'a', 'Ada')
    expect(first.accepted).toBe(true)
    expect(joinViewer(first.session, 'a', 'Ada').session.viewers).toHaveLength(1)
    expect(joinViewer(first.session, 'b', 'Bea')).toMatchObject({ accepted: false, reason: 'room-full' })
  })
  it('removes kicked viewers and closes the room', () => {
    const joined = joinViewer(createHostSession(2), 'a', 'Ada').session
    const kicked = removeViewer(joined, 'a')
    expect(kicked.viewers).toHaveLength(0)
    expect(joinViewer(closeHostSession(kicked), 'b', 'Bea')).toMatchObject({
      accepted: false,
      reason: 'closed',
    })
  })
  it('clamps viewer limits', () => {
    expect(createHostSession(0).maxViewers).toBe(1)
    expect(createHostSession(100).maxViewers).toBe(32)
  })
  it('tracks each viewer connection independently', () => {
    const one = joinViewer(createHostSession(2), 'a', 'Ada').session
    const two = joinViewer(one, 'b', 'Bea').session
    expect(setViewerConnection(two, 'a', 'failed').viewers).toEqual([
      { peerId: 'a', name: 'Ada', connection: 'failed' },
      { peerId: 'b', name: 'Bea', connection: 'connected' },
    ])
  })
})
