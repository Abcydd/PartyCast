export const REACTIONS = ['👍', '😂', '😮', '😢', '🔥', '❤️', '👏', '💀'] as const
export type Reaction = (typeof REACTIONS)[number]
export function isReaction(value: unknown): value is Reaction {
  return typeof value === 'string' && REACTIONS.includes(value as Reaction)
}
