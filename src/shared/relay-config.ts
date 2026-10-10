export type HookConfig = { executable: string; args: string[] }
export type RelayQuality = '1080p' | '1080p-high' | '720p'
export const RELAY_BITRATES: Record<RelayQuality, number> = { '1080p': 4_500_000, '1080p-high': 6_000_000, '720p': 2_500_000 }
export const RELAY_HEIGHT: Record<RelayQuality, number> = { '1080p': 1080, '1080p-high': 1080, '720p': 720 }
export const DEFAULT_RELAY_URL = 'https://partycast-relay.abcyd.workers.dev'

export function validRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' }
  catch { return false }
}
export function validateHook(value: unknown): HookConfig {
  if (!value || typeof value !== 'object') return { executable: '', args: [] }
  const v = value as Record<string, unknown>
  const executable = typeof v.executable === 'string' && v.executable.length <= 1024 && (/^[a-zA-Z]:\\/.test(v.executable) || v.executable.startsWith('\\\\')) && !/[\r\n\0]/.test(v.executable) ? v.executable : ''
  const args = Array.isArray(v.args) && v.args.length <= 16 && v.args.every(a => typeof a === 'string' && a.length <= 256 && !/[\r\n\0]/.test(a)) ? v.args : []
  return { executable, args: executable ? args : [] }
}
export function parseHostKeyFile(text: string): { relayUrl: string; hostKey: string } | null {
  if (text.length > 4096) return null
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const entries = new Map<string, string>()
  for (const line of lines) {
    const match = /^(PARTYCAST_RELAY_URL|PARTYCAST_HOST_KEY)=(.*)$/.exec(line.trim())
    if (match) entries.set(match[1], match[2].trim().replace(/^['"]|['"]$/g, ''))
  }
  const relayUrl = entries.get('PARTYCAST_RELAY_URL')
  const hostKey = entries.get('PARTYCAST_HOST_KEY')
  return validRelayUrl(relayUrl) && hostKey && hostKey.length >= 16 && hostKey.length <= 512 && !/\s/.test(hostKey) ? { relayUrl, hostKey } : null
}
