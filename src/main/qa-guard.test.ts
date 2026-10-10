import { describe, expect, it } from 'vitest'
import { getQaOverrides } from './qa-guard'

describe('isPackaged QA-override guard', () => {
  const fullQaEnv: NodeJS.ProcessEnv = {
    PARTYCAST_QA: '1',
    PARTYCAST_QA_PORT: '9222',
    PARTYCAST_QA_PROFILE: 'C:\\profiles\\qa',
    PARTYCAST_QA_HOST_KEY: 'qa-super-secret-host-key-12345',
    PARTYCAST_QA_RELAY_URL: 'https://qa-relay.example.com',
    PARTYCAST_QA_CONTROL_DIRECT: '1',
  }

  it('ignores all QA overrides when isPackaged is true', () => {
    const qa = getQaOverrides(true, fullQaEnv)
    expect(qa.isQa).toBe(false)
    expect(qa.qaPort).toBeUndefined()
    expect(qa.qaProfile).toBeUndefined()
    expect(qa.qaHostKey).toBeUndefined()
    expect(qa.qaRelayUrl).toBeUndefined()
    expect(qa.qaControlDirect).toBe(false)
  })

  it('enables all QA overrides when isPackaged is false and PARTYCAST_QA is 1', () => {
    const qa = getQaOverrides(false, fullQaEnv)
    expect(qa.isQa).toBe(true)
    expect(qa.qaPort).toBe('9222')
    expect(qa.qaProfile).toBe('C:\\profiles\\qa')
    expect(qa.qaHostKey).toBe('qa-super-secret-host-key-12345')
    expect(qa.qaRelayUrl).toBe('https://qa-relay.example.com')
    expect(qa.qaControlDirect).toBe(true)
  })

  it('disables QA overrides when PARTYCAST_QA is missing or not 1', () => {
    const qaMissing = getQaOverrides(false, { ...fullQaEnv, PARTYCAST_QA: undefined })
    expect(qaMissing.isQa).toBe(false)
    expect(qaMissing.qaPort).toBeUndefined()

    const qaZero = getQaOverrides(false, { ...fullQaEnv, PARTYCAST_QA: '0' })
    expect(qaZero.isQa).toBe(false)
    expect(qaZero.qaHostKey).toBeUndefined()
  })
})
