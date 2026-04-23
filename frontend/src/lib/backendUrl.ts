/**
 * HTTP API origin for REST calls (`''` = same origin; Vite dev proxy forwards `/api`).
 */
export function getApiBase(): string {
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? ''
}

/**
 * Build a WebSocket URL for endpoints that still use WS (e.g. live quotes).
 */
export function getBackendWsUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const explicitBase = import.meta.env.VITE_API_BASE as string | undefined

  if (explicitBase && explicitBase.length > 0) {
    const base = new URL(explicitBase)
    const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${base.host}${normalized}`
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${window.location.host}${normalized}`
}
