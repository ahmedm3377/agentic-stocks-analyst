import { getApiBase } from '../lib/backendUrl'

export type AnalyzePollResponse = {
  events: unknown[]
  next_after: number
}

export async function startAnalyzeSession(
  ticker: string,
  query: string,
): Promise<{ session_id: string }> {
  const r = await fetch(`${getApiBase()}/api/analyze/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker, query }),
  })
  if (!r.ok) throw new Error((await r.text()) || r.statusText)
  return r.json() as Promise<{ session_id: string }>
}

export async function pollAnalyzeSession(
  sessionId: string,
  after: number,
): Promise<AnalyzePollResponse> {
  const r = await fetch(
    `${getApiBase()}/api/analyze/session/${encodeURIComponent(sessionId)}/poll?after=${after}`,
  )
  if (!r.ok) throw new Error((await r.text()) || r.statusText)
  return r.json() as Promise<AnalyzePollResponse>
}

export async function postAnalyzeFeedback(sessionId: string, message: string): Promise<void> {
  const r = await fetch(
    `${getApiBase()}/api/analyze/session/${encodeURIComponent(sessionId)}/feedback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    },
  )
  if (!r.ok) throw new Error((await r.text()) || r.statusText)
}

export async function postAnalyzeChat(
  sessionId: string,
  question: string,
  context: Record<string, unknown>,
): Promise<void> {
  const r = await fetch(
    `${getApiBase()}/api/analyze/session/${encodeURIComponent(sessionId)}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, context }),
    },
  )
  if (!r.ok) throw new Error((await r.text()) || r.statusText)
}
