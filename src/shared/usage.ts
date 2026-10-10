export type RelayUsage = { month: string; estGB: number; capGB: number }
export type UsageLevel = 'ok' | 'warn' | 'critical' | 'capped'

const MONTH_REGEX = /^\d{4}-\d{2}$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function parseUsage(body: unknown): RelayUsage | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (typeof record.month !== 'string' || !MONTH_REGEX.test(record.month)) return null
  if (typeof record.estGB !== 'number' || !Number.isFinite(record.estGB) || record.estGB < 0) return null
  if (typeof record.capGB !== 'number' || !Number.isFinite(record.capGB) || record.capGB <= 0) return null
  return { month: record.month, estGB: record.estGB, capGB: record.capGB }
}

export function usageLevel(estGB: number, capGB: number): UsageLevel {
  const ratio = estGB / capGB
  if (ratio >= 1) return 'capped'
  if (ratio >= 0.95) return 'critical'
  if (ratio >= 0.8) return 'warn'
  return 'ok'
}

export function usagePercent(estGB: number, capGB: number): number {
  if (!Number.isFinite(estGB) || !Number.isFinite(capGB) || capGB <= 0) return 0
  return Math.min(100, Math.max(0, (estGB / capGB) * 100))
}

export function formatUsage(usage: RelayUsage): string {
  const est = usage.estGB < 10 ? usage.estGB.toFixed(1) : String(Math.round(usage.estGB))
  return `${est} / ${Math.round(usage.capGB)} GB`
}

export function monthLabel(month: string): string {
  const match = MONTH_REGEX.exec(month)
  if (!match) return ''
  return MONTHS[Number(match[0].slice(5)) - 1] ?? ''
}

export function nextMonthStart(month: string): string {
  const match = MONTH_REGEX.exec(month)
  if (!match) return ''
  const parsed = Number(match[0].slice(5))
  if (parsed < 1 || parsed > 12) return ''
  return `${parsed === 12 ? MONTHS[0] : MONTHS[parsed]} 1`
}
