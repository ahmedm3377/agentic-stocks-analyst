import type { TickerListResponse } from '../types/tickers'

const base = import.meta.env.VITE_API_BASE ?? ''

/** List from ``GET /api/tickers`` (yfinance ``most_actives`` screener by default). */
export async function fetchPopularTickers(limit = 50): Promise<TickerListResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  const res = await fetch(`${base}/api/tickers?${params}`)
  if (!res.ok) {
    throw new Error(`Failed to load tickers (${res.status})`)
  }
  return res.json() as Promise<TickerListResponse>
}
