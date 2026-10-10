export type Settings = {
  displayName: string
  maxViewers: number
  turn: { url: string; username: string; credential: string }
}

export const defaultSettings: Settings = {
  displayName: '',
  maxViewers: 8,
  turn: { url: '', username: '', credential: '' },
}

export function sanitizeSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') return structuredClone(defaultSettings)
  const candidate = value as Partial<Settings>
  const turn = candidate.turn && typeof candidate.turn === 'object' ? candidate.turn : defaultSettings.turn
  return {
    displayName: typeof candidate.displayName === 'string' ? candidate.displayName.trim().slice(0, 40) : '',
    maxViewers: Number.isInteger(candidate.maxViewers) ? Math.max(1, Math.min(32, candidate.maxViewers!)) : 8,
    turn: {
      url: typeof turn.url === 'string' && /^(turns?):\S+$/i.test(turn.url) ? turn.url : '',
      username: typeof turn.username === 'string' ? turn.username.slice(0, 256) : '',
      credential: typeof turn.credential === 'string' ? turn.credential.slice(0, 256) : '',
    },
  }
}
