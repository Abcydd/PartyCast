export type ByteRange = { start: number; end: number }

export function parseRangeHeader(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  if (!Number.isSafeInteger(size) || size < 0) return 'unsatisfiable'
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) return 'unsatisfiable'
  const startPart = match[1]
  const endPart = match[2]
  if (!startPart) {
    const suffix = Number(endPart)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startPart)
  const end = endPart ? Number(endPart) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end)
    return 'unsatisfiable'
  return { start, end: Math.min(size - 1, end) }
}
