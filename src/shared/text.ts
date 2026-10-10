// Control characters are deliberately matched here so untrusted text cannot affect rendering.
// eslint-disable-next-line no-control-regex
const unsafeControls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

export function sanitizeText(value: string, maxLength: number): string {
  return Array.from(value.replace(unsafeControls, '')).slice(0, maxLength).join('').trim()
}

export const sanitizeName = (value: string): string => sanitizeText(value, 32)
export const sanitizeChat = (value: string): string => sanitizeText(value, 500)

export function sanitizeSubtitleText(value: string): string {
  const plain = value.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')
  return Array.from(
    plain
      .split(/\r?\n/)
      .map((line) => sanitizeText(line, 500))
      .filter(Boolean)
      .join('\n'),
  )
    .slice(0, 500)
    .join('')
}
