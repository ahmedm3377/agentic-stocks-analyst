import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { fetchTickerAutocomplete } from './api/autocomplete'
import { fetchStockQuote } from './api/quote'
import { fetchPopularTickers } from './api/tickers'
import type { Momentum, StockQuoteResponse, Trend } from './types/quote'
import type { TickerEntry, TickerSuggestion } from './types/tickers'

type DisplayRow = {
  symbol: string
  name: string
  meta?: string
}

const SUGGEST_DEBOUNCE_MS = 220

function SearchSpinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-violet-500 border-t-transparent dark:border-violet-400 dark:border-t-transparent ${className ?? ''}`}
    />
  )
}

function formatPct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function pctColor(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) {
    return 'text-zinc-500 dark:text-zinc-400'
  }
  if (value > 0) return 'text-emerald-600 dark:text-emerald-400'
  if (value < 0) return 'text-rose-600 dark:text-rose-400'
  return 'text-zinc-600 dark:text-zinc-300'
}

function trendStyles(t: Trend): string {
  switch (t) {
    case 'bullish':
      return 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300'
    case 'bearish':
      return 'bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300'
    default:
      return 'bg-amber-500/15 text-amber-800 ring-amber-500/30 dark:text-amber-200'
  }
}

function momentumStyles(m: Momentum): string {
  switch (m) {
    case 'strong':
      return 'bg-violet-500/15 text-violet-800 ring-violet-500/30 dark:text-violet-200'
    case 'weak':
      return 'bg-slate-500/20 text-slate-700 ring-slate-500/25 dark:text-slate-300'
    default:
      return 'bg-sky-500/15 text-sky-800 ring-sky-500/30 dark:text-sky-200'
  }
}

function suggestionToRows(items: TickerSuggestion[]): DisplayRow[] {
  return items.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    meta: [s.exchange, s.kind].filter(Boolean).join(' · ') || undefined,
  }))
}

function filterPopular(popular: TickerEntry[], q: string): DisplayRow[] {
  const t = q.trim().toLowerCase()
  if (!t) return []
  return popular
    .filter(
      (p) =>
        p.symbol.toLowerCase().includes(t) || p.name.toLowerCase().includes(t),
    )
    .slice(0, 10)
    .map((p) => ({ symbol: p.symbol, name: p.name, meta: 'Popular list' }))
}

function getLiveQuoteWsUrl(ticker: string): string {
  const symbol = encodeURIComponent(ticker.trim().toUpperCase())
  const explicitBase = import.meta.env.VITE_API_BASE as string | undefined

  if (explicitBase && explicitBase.length > 0) {
    const base = new URL(explicitBase)
    const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${base.host}/api/stock/live/${symbol}`
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${window.location.host}/api/stock/live/${symbol}`
}

function App() {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const blurCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [query, setQuery] = useState('AAPL')
  const [data, setData] = useState<StockQuoteResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [liveConnected, setLiveConnected] = useState(false)
  const [liveConnecting, setLiveConnecting] = useState(false)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [lastLiveTs, setLastLiveTs] = useState<number | null>(null)

  const [popular, setPopular] = useState<TickerEntry[]>([])
  const [remoteRows, setRemoteRows] = useState<DisplayRow[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [debouncingSearch, setDebouncingSearch] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)

  useEffect(() => {
    void fetchPopularTickers()
      .then((r) => setPopular(r.tickers))
      .catch(() => setPopular([]))
  }, [])

  const trimmed = query.trim()
  const displayRows = useMemo((): DisplayRow[] => {
    if (!trimmed) {
      return popular.slice(0, 12).map((p) => ({
        symbol: p.symbol,
        name: p.name,
        meta: 'Popular',
      }))
    }
    if (remoteRows.length > 0) return remoteRows
    return filterPopular(popular, trimmed)
  }, [trimmed, popular, remoteRows])

  const searchInFlight = debouncingSearch || suggestLoading

  useEffect(() => {
    if (!trimmed) {
      setRemoteRows([])
      setSuggestLoading(false)
      setDebouncingSearch(false)
      return
    }

    setDebouncingSearch(true)
    setRemoteRows([])
    let cancelled = false
    const t = window.setTimeout(() => {
      setDebouncingSearch(false)
      void (async () => {
        setSuggestLoading(true)
        try {
          const res = await fetchTickerAutocomplete(trimmed)
          if (!cancelled) {
            setRemoteRows(suggestionToRows(res.suggestions))
            setHighlightIndex(-1)
          }
        } catch {
          if (!cancelled) {
            setRemoteRows([])
          }
        } finally {
          if (!cancelled) {
            setSuggestLoading(false)
          }
        }
      })()
    }, SUGGEST_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(t)
      setDebouncingSearch(false)
    }
  }, [trimmed])

  const fetchQuote = useCallback(async (ticker: string) => {
    const sym = ticker.trim().toUpperCase()
    if (!sym) return
    setError(null)
    setLoading(true)
    setMenuOpen(false)
    setHighlightIndex(-1)
    try {
      const quote = await fetchStockQuote(sym)
      setData(quote)
    } catch (err) {
      setData(null)
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  const pickRow = useCallback(
    (symbol: string) => {
      const sym = symbol.trim().toUpperCase()
      setQuery(sym)
      void fetchQuote(sym)
    },
    [fetchQuote],
  )

  useEffect(() => {
    if (!data?.ticker) {
      setLiveConnected(false)
      setLiveConnecting(false)
      setLiveError(null)
      return
    }

    const ws = new WebSocket(getLiveQuoteWsUrl(data.ticker))
    setLiveConnecting(true)
    setLiveConnected(false)
    setLiveError(null)

    ws.onopen = () => {
      setLiveConnecting(false)
      setLiveConnected(true)
      setLiveError(null)
    }

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type?: string
          ticker?: string
          price?: number
          change_pct?: number
          ts?: number
          detail?: string
        }

        if (payload.type === 'error') {
          setLiveError(payload.detail ?? 'Live stream error')
          return
        }

        if (payload.type !== 'quote_update') return

        setData((prev) => {
          if (!prev || !payload.ticker || prev.ticker !== payload.ticker) {
            return prev
          }

          const nextPrice = typeof payload.price === 'number' ? payload.price : prev.price
          const nextDayChange =
            typeof payload.change_pct === 'number' ? payload.change_pct : prev.changes_pct.day

          return {
            ...prev,
            price: nextPrice,
            changes_pct: { ...prev.changes_pct, day: nextDayChange },
          }
        })

        if (typeof payload.ts === 'number') {
          setLastLiveTs(payload.ts)
        }
      } catch {
        // Ignore malformed live packets
      }
    }

    ws.onerror = () => {
      setLiveConnecting(false)
      setLiveConnected(false)
      setLiveError('Live connection failed')
    }

    ws.onclose = () => {
      setLiveConnecting(false)
      setLiveConnected(false)
    }

    return () => {
      ws.close()
    }
  }, [data?.ticker])

  const showMenu = menuOpen && (displayRows.length > 0 || searchInFlight)

  function onInputFocus() {
    if (blurCloseTimer.current) {
      clearTimeout(blurCloseTimer.current)
      blurCloseTimer.current = null
    }
    setMenuOpen(true)
  }

  function onInputBlur() {
    blurCloseTimer.current = setTimeout(() => {
      setMenuOpen(false)
      setHighlightIndex(-1)
    }, 120)
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setMenuOpen(false)
      setHighlightIndex(-1)
      return
    }

    if (!showMenu && e.key === 'ArrowDown' && displayRows.length > 0) {
      e.preventDefault()
      setMenuOpen(true)
      setHighlightIndex(0)
      return
    }

    if (!showMenu) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((i) =>
        displayRows.length ? Math.min(i + 1, displayRows.length - 1) : -1,
      )
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && highlightIndex >= 0 && displayRows[highlightIndex]) {
      e.preventDefault()
      pickRow(displayRows[highlightIndex].symbol)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    await fetchQuote(query)
  }

  return (
    <div className="min-h-svh bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-12 sm:px-6">
        <header className="text-center sm:text-left">
          <p className="text-sm font-medium tracking-wide text-violet-600 dark:text-violet-400">
            Market behavior
          </p>
          <h1 className="mt-1 font-semibold tracking-tight text-3xl text-zinc-900 sm:text-4xl dark:text-white">
            Stock snapshot
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Choose a suggestion or press Enter — the quote loads as soon as a ticker is selected.
          </p>
        </header>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-1 flex-col gap-1.5 text-left">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Ticker
            </span>
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded={showMenu}
                aria-controls={listId}
                aria-autocomplete="list"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={onInputFocus}
                onBlur={onInputBlur}
                onKeyDown={onInputKeyDown}
                placeholder="Company name or symbol (e.g. NVIDIA or NVDA)…"
                autoComplete="off"
                spellCheck={false}
                disabled={loading}
                aria-busy={loading || searchInFlight}
                className={`w-full rounded-xl border border-zinc-200 bg-white py-3 text-base font-medium outline-none ring-violet-500/0 transition placeholder:text-zinc-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-violet-400 ${
                  trimmed && searchInFlight ? 'pl-4 pr-12' : 'px-4'
                }`}
              />
              {trimmed && searchInFlight && (
                <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
                  <SearchSpinner />
                  <span className="sr-only">Searching for matches</span>
                </div>
              )}
              {showMenu && (
                <ul
                  id={listId}
                  role="listbox"
                  aria-busy={searchInFlight}
                  className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-none"
                >
                  {searchInFlight && trimmed && (
                    <li className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                      <SearchSpinner className="size-3.5" />
                      {debouncingSearch ? 'Finding matches…' : 'Searching…'}
                    </li>
                  )}
                  {displayRows.map((row, idx) => (
                    <li
                      key={`${row.symbol}-${row.meta ?? ''}-${idx}`}
                      role="option"
                      aria-selected={idx === highlightIndex}
                    >
                      <button
                        type="button"
                        className={`flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left text-sm transition hover:bg-violet-50 dark:hover:bg-violet-950/40 ${
                          idx === highlightIndex
                            ? 'bg-violet-100 dark:bg-violet-950/60'
                            : ''
                        }`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickRow(row.symbol)}
                      >
                        <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                          {row.symbol}
                        </span>
                        <span className="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                          {row.name}
                        </span>
                        {row.meta && (
                          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                            {row.meta}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </form>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200"
          >
            {error}
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-6">
            <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-lg shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900/80 dark:shadow-none">
              <div className="border-b border-zinc-100 bg-linear-to-br from-violet-500/10 via-transparent to-transparent px-6 py-6 dark:border-zinc-800 dark:from-violet-500/5">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                      <span>{data.ticker}</span>
                      {liveConnecting && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          <SearchSpinner className="size-2.5" />
                          Connecting
                        </span>
                      )}
                      {liveConnected && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                          <span className="size-1.5 rounded-full bg-emerald-500" />
                          Live
                        </span>
                      )}
                    </p>
                    <p className="mt-1 flex items-baseline gap-2">
                      <span className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
                        {data.price.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                      <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                        {data.currency}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {liveError
                        ? liveError
                        : liveConnected
                          ? `Streaming live${lastLiveTs ? ` · ${new Date(lastLiveTs * 1000).toLocaleTimeString()}` : ''}`
                          : 'Live stream idle'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold capitalize ring-1 ring-inset ${trendStyles(data.summary.trend)}`}
                    >
                      Trend: {data.summary.trend}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold capitalize ring-1 ring-inset ${momentumStyles(data.summary.momentum)}`}
                    >
                      Momentum: {data.summary.momentum}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${
                        data.summary.unusual_activity
                          ? 'bg-amber-500/20 text-amber-900 ring-amber-500/40 dark:text-amber-200'
                          : 'bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700'
                      }`}
                    >
                      Unusual volume: {data.summary.unusual_activity ? 'Yes' : 'No'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 p-6 sm:grid-cols-3">
                {(
                  [
                    { label: 'Day', value: data.changes_pct.day },
                    { label: 'Week (~5d)', value: data.changes_pct.week },
                    { label: 'Month (~21d)', value: data.changes_pct.month },
                  ] as const
                ).map(({ label, value }) => (
                  <div
                    key={label}
                    className="rounded-xl border border-zinc-100 bg-zinc-50/80 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/50"
                  >
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
                    <p className={`mt-1 text-2xl font-semibold tabular-nums ${pctColor(value)}`}>
                      {formatPct(value)}
                    </p>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 border-t border-zinc-100 px-6 py-6 sm:grid-cols-2 dark:border-zinc-800">
                <div className="rounded-xl border border-zinc-100 bg-zinc-50/50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/30">
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Volume vs 20-day avg
                  </p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {data.volume_vs_20d_avg != null
                      ? `${data.volume_vs_20d_avg.toFixed(2)}×`
                      : '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-100 bg-zinc-50/50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/30">
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Moving averages</p>
                  <dl className="mt-2 space-y-1 text-sm">
                    <div className="flex justify-between gap-4 tabular-nums">
                      <dt className="text-zinc-500 dark:text-zinc-400">SMA 5</dt>
                      <dd className="font-medium">
                        {data.indicators.sma_5 != null
                          ? data.indicators.sma_5.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })
                          : '—'}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 tabular-nums">
                      <dt className="text-zinc-500 dark:text-zinc-400">SMA 20</dt>
                      <dd className="font-medium">
                        {data.indicators.sma_20 != null
                          ? data.indicators.sma_20.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })
                          : '—'}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            </div>

            <p className="text-center text-xs text-zinc-500 dark:text-zinc-500">
              Data from your FastAPI quote endpoint · Not financial advice
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
