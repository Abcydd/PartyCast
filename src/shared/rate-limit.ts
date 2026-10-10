export type RateCategory = 'chat' | 'reaction' | 'other'
const capacities: Record<RateCategory, number> = { chat: 5, reaction: 10, other: 20 }
type Bucket = { tokens: number; updated: number }

export class PeerRateLimiter {
  private buckets = new Map<string, Bucket>()
  private violations = new Map<string, number>()

  check(peerId: string, category: RateCategory, now = Date.now()): { allowed: boolean; violations: number } {
    const key = `${peerId}:${category}`
    const capacity = capacities[category]
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updated: now }
    bucket.tokens = Math.min(capacity, bucket.tokens + (Math.max(0, now - bucket.updated) / 5000) * capacity)
    bucket.updated = now
    if (bucket.tokens < 1) return { allowed: false, violations: this.violate(peerId) }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return { allowed: true, violations: this.violations.get(peerId) ?? 0 }
  }

  violate(peerId: string): number {
    const count = (this.violations.get(peerId) ?? 0) + 1
    this.violations.set(peerId, count)
    return count
  }

  forget(peerId: string): void {
    for (const category of ['chat', 'reaction', 'other']) this.buckets.delete(`${peerId}:${category}`)
    this.violations.delete(peerId)
  }
}
