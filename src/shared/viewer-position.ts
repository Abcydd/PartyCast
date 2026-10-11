export type PlaybackState = { currentTime: number; duration: number; playing: boolean; sentAt: number }

export function viewerPosition(state: PlaybackState, now: number): number {
  const elapsed = state.playing ? Math.max(0, now - state.sentAt) / 1000 : 0
  return Math.min(Math.max(0, state.duration), Math.max(0, state.currentTime + elapsed))
}
