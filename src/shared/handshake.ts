export type Handshake =
  | { role: 'viewer' }
  | { role: 'host'; status: 'ok' | 'full' | 'locked' | 'banned' }

export function parseHandshake(value: unknown): Handshake | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (data.role === 'viewer' && data.status === undefined) return { role: 'viewer' }
  if (
    data.role === 'host' &&
    (data.status === 'ok' || data.status === 'full' || data.status === 'locked' || data.status === 'banned')
  ) return { role: 'host', status: data.status }
  return null
}
