export type Trend = 'bullish' | 'bearish' | 'mixed'
export type Momentum = 'weak' | 'moderate' | 'strong'

export interface StockQuoteResponse {
  ticker: string
  price: number
  currency: string
  changes_pct: {
    day: number | null
    week: number | null
    month: number | null
  }
  volume_vs_20d_avg: number | null
  indicators: {
    sma_5: number | null
    sma_20: number | null
  }
  summary: {
    trend: Trend
    momentum: Momentum
    unusual_activity: boolean
  }
}
