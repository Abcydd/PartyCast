export type Quality = 'auto' | 'low' | 'medium' | 'high' | 'source'
export type EffectiveQuality = Exclude<Quality, 'auto'>
export const BITRATES: Record<EffectiveQuality, number> = {
  low: 1_000_000,
  medium: 2_500_000,
  high: 5_000_000,
  source: 8_000_000,
}
export function effectiveQuality(quality: Quality, approvedViewers: number, uploadMbps: number): EffectiveQuality {
  if (quality !== 'auto') return quality
  return approvedViewers * 2.5 > uploadMbps ? 'low' : 'medium'
}
export function estimatedUploadMbps(quality: EffectiveQuality, approvedViewers: number): number {
  return (BITRATES[quality] * approvedViewers) / 1_000_000
}
