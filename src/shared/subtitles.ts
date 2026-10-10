import { sanitizeSubtitleText } from './text'

export type Cue = { start: number; end: number; text: string }

function parseTimestamp(value: string): number | null {
  const match = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)[,.](\d{1,3})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const millis = Number(match[4].padEnd(3, '0'))
  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

export function parseSubtitles(input: string): Cue[] {
  const content = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = content.split(/\n\s*\n/)
  const cues: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim())
    const timing = lines.findIndex((line) => line.includes('-->'))
    if (timing < 0) continue
    const parts = /^([^\s]+)\s+-->\s+([^\s]+)/.exec(lines[timing])
    if (!parts) continue
    const start = parseTimestamp(parts[1])
    const end = parseTimestamp(parts[2])
    const text = sanitizeSubtitleText(lines.slice(timing + 1).join('\n'))
    if (start === null || end === null || end <= start || !text) continue
    cues.push({ start, end, text })
    if (cues.length >= 10000) break
  }
  return cues.sort((a, b) => a.start - b.start)
}

export function cueAtTime(cues: Cue[], playbackTime: number, offsetSeconds = 0): Cue | null {
  const time = playbackTime - offsetSeconds
  let left = 0, right = cues.length - 1
  while (left <= right) {
    const mid = (left + right) >>> 1
    if (cues[mid].start <= time) left = mid + 1
    else right = mid - 1
  }
  for (let i = right; i >= 0; i--) {
    if (cues[i].start <= time) return cues[i]
  }
  return null
}
