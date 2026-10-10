import type { Settings } from './settings'

export type PickedMedia = { url: string; title: string }
export type PartyCastApi = {
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<Settings>
  pickMedia(): Promise<PickedMedia | null>
  registerDroppedFile(file: File): Promise<PickedMedia | null>
}
