export async function proxySfu(appId: string, secret: string, method: string, path: string, payload?: unknown, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(`https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}${path}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) })
  const data: unknown = await response.json().catch(() => ({}))
  if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data) || 'errorCode' in data || 'tracks' in data && Array.isArray(data.tracks) && data.tracks.some((t: unknown) => !!t && typeof t === 'object' && 'errorCode' in t)) throw new Error('sfu-error')
  return data as Record<string, unknown>
}
