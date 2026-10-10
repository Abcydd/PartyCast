export type QaOverrides = {
  isQa: boolean
  qaPort?: string
  qaProfile?: string
  qaHostKey?: string
  qaRelayUrl?: string
  qaControlDirect: boolean
}

export function getQaOverrides(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): QaOverrides {
  if (isPackaged || env.PARTYCAST_QA !== '1') {
    return {
      isQa: false,
      qaControlDirect: false,
    }
  }
  return {
    isQa: true,
    qaPort: env.PARTYCAST_QA_PORT,
    qaProfile: env.PARTYCAST_QA_PROFILE,
    qaHostKey: env.PARTYCAST_QA_HOST_KEY,
    qaRelayUrl: env.PARTYCAST_QA_RELAY_URL,
    qaControlDirect: env.PARTYCAST_QA_CONTROL_DIRECT === '1',
  }
}
