import { describe, expect, it } from 'vitest'
import { formatUsage, monthLabel, nextMonthStart, parseUsage, usageLevel, usagePercent } from './usage'

describe('parseUsage', () => {
  it('accepts a valid usage body', () => {
    expect(parseUsage({ month: '2026-10', estGB: 112.4, capGB: 900 })).toEqual({ month: '2026-10', estGB: 112.4, capGB: 900 })
    expect(parseUsage({ month: '2026-01', estGB: 0, capGB: 1 })).toEqual({ month: '2026-01', estGB: 0, capGB: 1 })
  })
  it('rejects non-object and missing bodies', () => {
    expect(parseUsage(null)).toBeNull()
    expect(parseUsage(undefined)).toBeNull()
    expect(parseUsage('2026-10')).toBeNull()
    expect(parseUsage(112.4)).toBeNull()
    expect(parseUsage([])).toBeNull()
    expect(parseUsage({})).toBeNull()
    expect(parseUsage({ month: '2026-10' })).toBeNull()
    expect(parseUsage({ estGB: 112.4, capGB: 900 })).toBeNull()
  })
  it('rejects a malformed month', () => {
    expect(parseUsage({ month: '2026-1', estGB: 1, capGB: 900 })).toBeNull()
    expect(parseUsage({ month: '26-10', estGB: 1, capGB: 900 })).toBeNull()
    expect(parseUsage({ month: '2026-10x', estGB: 1, capGB: 900 })).toBeNull()
    expect(parseUsage({ month: 2026, estGB: 1, capGB: 900 })).toBeNull()
  })
  it('rejects bad estGB values', () => {
    expect(parseUsage({ month: '2026-10', estGB: '112.4', capGB: 900 })).toBeNull()
    expect(parseUsage({ month: '2026-10', estGB: Number.NaN, capGB: 900 })).toBeNull()
    expect(parseUsage({ month: '2026-10', estGB: Number.POSITIVE_INFINITY, capGB: 900 })).toBeNull()
    expect(parseUsage({ month: '2026-10', estGB: -1, capGB: 900 })).toBeNull()
  })
  it('rejects bad capGB values', () => {
    expect(parseUsage({ month: '2026-10', estGB: 112.4, capGB: '900' })).toBeNull()
    expect(parseUsage({ month: '2026-10', estGB: 112.4, capGB: 0 })).toBeNull()
    expect(parseUsage({ month: '2026-10', estGB: 112.4, capGB: -900 })).toBeNull()
    expect(parseUsage({ month: '2026-10', estGB: 112.4, capGB: Number.NaN })).toBeNull()
  })
  it('ignores extra fields', () => {
    expect(parseUsage({ month: '2026-10', estGB: 1, capGB: 2, extra: true })).toEqual({ month: '2026-10', estGB: 1, capGB: 2 })
  })
})

describe('usageLevel', () => {
  it('splits ok below 80%, warn 80 to below 95, critical 95 to below 100, capped at 100', () => {
    expect(usageLevel(0, 900)).toBe('ok')
    expect(usageLevel(79.9, 100)).toBe('ok')
    expect(usageLevel(80, 100)).toBe('warn')
    expect(usageLevel(94.9, 100)).toBe('warn')
    expect(usageLevel(95, 100)).toBe('critical')
    expect(usageLevel(99.9, 100)).toBe('critical')
    expect(usageLevel(100, 100)).toBe('capped')
  })
  it('stays capped above the cap', () => {
    expect(usageLevel(112.4, 100)).toBe('capped')
    expect(usageLevel(1800, 900)).toBe('capped')
  })
})

describe('usagePercent', () => {
  it('keeps ordinary ratios as-is', () => {
    expect(usagePercent(50, 100)).toBe(50)
    expect(usagePercent(112.4, 900)).toBeCloseTo(12.49, 2)
    expect(usagePercent(0, 900)).toBe(0)
  })
  it('clamps estGB above the cap to 100', () => {
    expect(usagePercent(900, 900)).toBe(100)
    expect(usagePercent(112.4, 100)).toBe(100)
    expect(usagePercent(1800, 900)).toBe(100)
  })
  it('clamps negative or invalid input to 0', () => {
    expect(usagePercent(-5, 100)).toBe(0)
    expect(usagePercent(10, 0)).toBe(0)
    expect(usagePercent(Number.NaN, 900)).toBe(0)
    expect(usagePercent(10, Number.NaN)).toBe(0)
  })
})

describe('formatUsage', () => {
  it('shows whole numbers and keeps one decimal below 10 GB', () => {
    expect(formatUsage({ month: '2026-10', estGB: 112.4, capGB: 900 })).toBe('112 / 900 GB')
    expect(formatUsage({ month: '2026-10', estGB: 3.44, capGB: 900 })).toBe('3.4 / 900 GB')
    expect(formatUsage({ month: '2026-10', estGB: 0, capGB: 750.5 })).toBe('0.0 / 751 GB')
    expect(formatUsage({ month: '2026-10', estGB: 900, capGB: 900 })).toBe('900 / 900 GB')
  })
})

describe('monthLabel', () => {
  it('abbreviates the month', () => {
    expect(monthLabel('2026-10')).toBe('Oct')
    expect(monthLabel('2026-01')).toBe('Jan')
    expect(monthLabel('2026-12')).toBe('Dec')
  })
  it('returns nothing for malformed months', () => {
    expect(monthLabel('2026-13')).toBe('')
    expect(monthLabel('October')).toBe('')
  })
})

describe('nextMonthStart', () => {
  it('steps to the first of the next month', () => {
    expect(nextMonthStart('2026-10')).toBe('Nov 1')
    expect(nextMonthStart('2026-01')).toBe('Feb 1')
  })
  it('rolls December into January', () => {
    expect(nextMonthStart('2026-12')).toBe('Jan 1')
    expect(nextMonthStart('2025-12')).toBe('Jan 1')
  })
})
