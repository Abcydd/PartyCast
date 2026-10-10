// Injected by electron.vite.config.ts into the main process build from the
// PARTYCAST_DEFAULT_RELAY_URL environment variable. Empty string when the
// variable is unset. Never contains a key or secret — the build rejects
// anything that is not a bare https:// origin.
declare const __DEFAULT_RELAY_URL__: string
