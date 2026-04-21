/**
 * Crew session WebSocket — must match FastAPI `ANALYZE_WEBSOCKET_PATH`.
 * All frames (status, task_output, review_needed, complete, chat_response, error) use this URL.
 */
export const ANALYZE_WEBSOCKET_PATH = '/api/analyze' as const

/**
 * Build a WebSocket URL for the FastAPI backend.
 * In dev, Vite proxies `/api` to 127.0.0.1:8000, so use the page host when
 * VITE_API_BASE is unset. With VITE_API_BASE set, connect directly to that host.
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

/** WebSocket URL for the multi-agent analyze session (`/api/analyze`). */
export function getAnalyzeWebSocketUrl(): string {
  return getBackendWsUrl(ANALYZE_WEBSOCKET_PATH)
}
