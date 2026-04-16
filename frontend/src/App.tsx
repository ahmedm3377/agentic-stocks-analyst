import { type FormEvent, useState } from 'react'
import { fetchStockQuote } from './api/quote'
import type { Momentum, StockQuoteResponse, Trend } from './types/quote'

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

function App() {
  const [query, setQuery] = useState('AAPL')
  const [data, setData] = useState<StockQuoteResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const quote = await fetchStockQuote(query)
      setData(quote)
    } catch (err) {
      setData(null)
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
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
            Enter a ticker to load price, multi-horizon moves, volume context, and a compact summary from your
            backend.
          </p>
        </header>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label className="flex flex-1 flex-col gap-1.5 text-left">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Ticker
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. MSFT"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-base font-medium outline-none ring-violet-500/0 transition placeholder:text-zinc-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-violet-400"
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-violet-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-violet-500 dark:hover:bg-violet-400"
          >
            {loading ? 'Loading…' : 'Get quote'}
          </button>
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
                    <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                      {data.ticker}
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
