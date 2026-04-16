export interface TickerEntry {
  symbol: string
  name: string
}

export interface TickerListResponse {
  tickers: TickerEntry[]
  count: number
  source: string
}

export interface TickerSuggestion {
  symbol: string
  name: string
  exchange: string | null
  kind: string | null
}

export interface TickerAutocompleteResponse {
  suggestions: TickerSuggestion[]
}
