import type { PartyCastApi } from '../../shared/electron-api'

declare global {
  interface Window {
    partycast: PartyCastApi
  }
}
export {}
