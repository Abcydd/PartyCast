export function codecPreferenceOrder<T extends { mimeType: string }>(codecs: readonly T[]): T[] {
  const rank = (mime: string): number => /\/AV1$/i.test(mime) ? 0 : /\/VP9$/i.test(mime) ? 1 : /\/H264$/i.test(mime) ? 2 : 3
  return [...codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType))
}

export function resolutionScale(width: number, height: number, maxWidth = 1920, maxHeight = 1080): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1
  return Math.max(1, width / maxWidth, height / maxHeight)
}

export function pinnedHostMatches(peerId: string, pinnedHostId: string | null): boolean {
  return !pinnedHostId || peerId === pinnedHostId
}
