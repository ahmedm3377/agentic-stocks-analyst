import type { TickerAutocompleteResponse } from '../types/tickers'

const base = import.meta.env.VITE_API_BASE ?? ''

/** Suggestions by company name or ticker (``GET /api/stock/autocomplete``). */
export async function fetchTickerAutocomplete(
  q: string,
  limit = 12,
): Promise<TickerAutocompleteResponse> {
  const trimmed = q.trim()
  if (!trimmed) {
    return { suggestions: [] }
  }
  const params = new URLSearchParams({ q: trimmed, limit: String(limit) })
  const res = await fetch(`${base}/api/stock/autocomplete?${params}`)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Autocomplete failed (${res.status})`)
  }
  return res.json() as Promise<TickerAutocompleteResponse>
}
