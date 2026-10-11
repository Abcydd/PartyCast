export type VideoCodecResult = { supported: boolean; powerEfficient: boolean }

const codecName = (mime: string): 'AV1' | 'H265' | 'H264' | 'VP9' | 'VP8' | null => {
  const name = mime.split('/').at(-1)?.split(';')[0]?.toUpperCase()
  if (name === 'AV1') return 'AV1'
  if (name === 'H265' || name === 'HEVC') return 'H265'
  if (name === 'H264') return 'H264'
  if (name === 'VP9') return 'VP9'
  if (name === 'VP8') return 'VP8'
  return null
}

/** Rank only the codecs offered by the local sender. RTX and repair codecs follow media codecs. */
export function codecPreferenceOrder<T extends { mimeType: string }>(
  codecs: readonly T[],
  results?: Readonly<Record<string, VideoCodecResult>>,
): T[] {
  const hardwareOrder = ['AV1', 'H265', 'H264', 'VP9']
  const fallbackOrder = ['H264', 'VP9', 'AV1', 'H265', 'VP8']
  const names = results
    ? [...hardwareOrder.filter(name => results[name]?.supported && results[name]?.powerEfficient), ...fallbackOrder]
    : fallbackOrder
  const preference = new Map<string, number>()
  names.forEach(name => { if (!preference.has(name)) preference.set(name, preference.size) })
  const primary = codecs.filter(codec => codecName(codec.mimeType) !== null)
  const auxiliary = codecs.filter(codec => codecName(codec.mimeType) === null)
  primary.sort((a, b) => (preference.get(codecName(a.mimeType) ?? '') ?? 99) - (preference.get(codecName(b.mimeType) ?? '') ?? 99))
  return [...primary, ...auxiliary]
}

export function resolutionScale(width: number, height: number, maxWidth = 1920, maxHeight = 1080): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1
  return Math.max(1, width / maxWidth, height / maxHeight)
}

export function pinnedHostMatches(peerId: string, pinnedHostId: string | null): boolean {
  return !pinnedHostId || peerId === pinnedHostId
}

/** Simulcast needs independent layers: H264/VP8 do that natively, VP9/AV1 only with scalabilityMode L1T*. Prefer the classic pair. */
export function simulcastCodecOrder<T extends { mimeType: string }>(codecs: readonly T[]): T[] {
  const order = ['H264', 'VP8', 'VP9', 'AV1', 'H265']
  const rank = (codec: T): number => { const name = codecName(codec.mimeType); return name ? order.indexOf(name) : 99 }
  return [...codecs].sort((a, b) => rank(a) - rank(b))
}
