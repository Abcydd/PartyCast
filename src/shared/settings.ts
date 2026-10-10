import { sanitizeName } from './text'
import { DEFAULT_RELAY_URL, validRelayUrl, validateHook, type HookConfig } from './relay-config'

export type Settings = {
  displayName: string
  maxViewers: number
  autoAccept: boolean
  uploadMbps: number
  relayOnly: boolean
  relayUrl: string
  hostStartHook: HookConfig
  hostStopHook: HookConfig
  turn: { url: string; username: string; credential: string }
}

export const defaultSettings: Settings = {
  displayName: '',
  maxViewers: 8,
  autoAccept: false,
  uploadMbps: 6,
  relayOnly: false,
  relayUrl: DEFAULT_RELAY_URL,
  hostStartHook: { executable: '', args: [] },
  hostStopHook: { executable: '', args: [] },
  turn: { url: '', username: '', credential: '' },
}

export function sanitizeSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') return structuredClone(defaultSettings)
  const candidate = value as Partial<Settings>
  const turn = candidate.turn && typeof candidate.turn === 'object' ? candidate.turn : defaultSettings.turn
  return {
    displayName: typeof candidate.displayName === 'string' ? sanitizeName(candidate.displayName) : '',
    maxViewers: Number.isInteger(candidate.maxViewers) ? Math.max(1, Math.min(32, candidate.maxViewers!)) : 8,
    autoAccept: candidate.autoAccept === true,
    uploadMbps: typeof candidate.uploadMbps === 'number' && Number.isFinite(candidate.uploadMbps) ? Math.max(0.5, Math.min(1000, candidate.uploadMbps)) : 6,
    relayOnly: typeof candidate.relayOnly === 'boolean' ? candidate.relayOnly : typeof turn.url === 'string' && /^(turns?):\S+$/i.test(turn.url),
    relayUrl: validRelayUrl(candidate.relayUrl) ? candidate.relayUrl.replace(/\/$/, '') : DEFAULT_RELAY_URL,
    hostStartHook: validateHook(candidate.hostStartHook),
    hostStopHook: validateHook(candidate.hostStopHook),
    turn: {
      url: typeof turn.url === 'string' && /^(turns?):\S+$/i.test(turn.url) ? turn.url : '',
      username: typeof turn.username === 'string' ? turn.username.slice(0, 256) : '',
      credential: typeof turn.credential === 'string' ? turn.credential.slice(0, 256) : '',
    },
  }
}
