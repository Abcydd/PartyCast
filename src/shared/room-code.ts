export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[-\s]/g, '')
}

export function isRoomCode(input: string): boolean {
  const normalized = normalizeRoomCode(input)
  return normalized.length === 6 && [...normalized].every((char) => ROOM_ALPHABET.includes(char))
}

export function formatRoomCode(input: string): string {
  const normalized = normalizeRoomCode(input)
  return `${normalized.slice(0, 3)}-${normalized.slice(3)}`
}

export function generateRoomCode(
  randomValues: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const result: string[] = []
  const limit = Math.floor(256 / ROOM_ALPHABET.length) * ROOM_ALPHABET.length
  while (result.length < 6) {
    const bytes = randomValues(new Uint8Array(8))
    for (const byte of bytes) {
      if (byte < limit) result.push(ROOM_ALPHABET[byte % ROOM_ALPHABET.length])
      if (result.length === 6) break
    }
  }
  return formatRoomCode(result.join(''))
}
