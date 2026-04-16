import type { StockQuoteResponse } from '../types/quote'

const base = import.meta.env.VITE_API_BASE ?? ''

export async function fetchStockQuote(ticker: string): Promise<StockQuoteResponse> {
  const symbol = ticker.trim().toUpperCase()
  if (!symbol) {
    throw new Error('Enter a ticker symbol')
  }

  const url = `${base}/api/stock/${encodeURIComponent(symbol)}/quote`
  const res = await fetch(url)

  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Request failed (${res.status})`)
  }

  return res.json() as Promise<StockQuoteResponse>
}
