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
import {
  fetchPreferences,
  parsePreferencesContent,
  updatePreferences,
} from './api/preferences'
import { getAnalyzeWebSocketUrl } from './lib/backendUrl'
import {
  type FinalReportData,
  isFinalReportData,
  isTaskOutputPayload,
  isTaskStartedPayload,
  type AnalyzeServerMessage,
  type TaskOutputPayload,
} from './types/agent'

function SearchSpinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-violet-500 border-t-transparent dark:border-violet-400 dark:border-t-transparent ${className ?? ''}`}
    />
  )
}

type SessionPhase = 'idle' | 'running' | 'awaiting_feedback' | 'done' | 'failed'

type ActivityEntry = {
  id: string
  message: string
  ts: number
}

type CrewDeliverable = TaskOutputPayload & { id: string; ts: number }
type AgentActivityItem =
  | { id: string; ts: number; kind: 'status'; message: string }
  | {
      id: string
      ts: number
      kind: 'working'
      task_name: string
      agent_role: string
    }
  | {
      id: string
      ts: number
      kind: 'task_output'
      task_name: string
      agent_role: string
      output: string
      truncated?: boolean
    }
type PriceTaskResult = {
  trend: string
  price_change_30d: number
  volume_signal: string
  summary: string
}
type JsonTaskResult = {
  ticker: string
  market_view: string
  trend: string
  key_catalysts: string[]
  bull_case: string
  bear_case: string
  main_risks: string[]
  confidence_level: string
}

type ChatMessage = { id: string; role: 'user' | 'advisor'; text: string }

const CHAT_SUGGESTIONS = [
  'Summarize the thesis in two sentences.',
  'What would most change your view on this name?',
  'How should I think about timing an entry?',
] as const

function ChatTypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-1 py-2" aria-label="Advisor is typing">
      <span className="size-1.5 animate-bounce rounded-full bg-violet-500/80 [animation-delay:0ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-violet-500/60 [animation-delay:150ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-violet-500/40 [animation-delay:300ms]" />
    </div>
  )
}

function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m <= 0) return `${s}s`
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

/** Crew task keys e.g. `review_report_task` → "Review Report Task" */
function formatCrewTaskTitle(raw: string): string {
  const s = raw.trim()
  if (!s) return 'Task'
  return s
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function analysisPhaseLabel(phase: SessionPhase): string {
  switch (phase) {
    case 'idle':
      return 'Ready'
    case 'running':
      return 'Agents working'
    case 'awaiting_feedback':
      return 'Your review'
    case 'done':
      return 'Complete'
    case 'failed':
      return 'Stopped'
    default:
      return '—'
  }
}

function parsePriceTaskResult(raw: string): PriceTaskResult | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.trend === 'string' &&
      typeof parsed.price_change_30d === 'number' &&
      typeof parsed.volume_signal === 'string' &&
      typeof parsed.summary === 'string'
    ) {
      return {
        trend: parsed.trend,
        price_change_30d: parsed.price_change_30d,
        volume_signal: parsed.volume_signal,
        summary: parsed.summary,
      }
    }
  } catch {
    // Not JSON; caller will render fallback text block.
  }
  return null
}

function trendBadgeStyles(trend: string): string {
  const t = trend.toLowerCase()
  if (t === 'bullish') return 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
  if (t === 'bearish') return 'bg-rose-500/15 text-rose-800 dark:text-rose-300'
  return 'bg-amber-500/15 text-amber-900 dark:text-amber-200'
}

function volumeBadgeStyles(volumeSignal: string): string {
  const v = volumeSignal.toLowerCase()
  if (v === 'high') return 'bg-violet-500/15 text-violet-900 dark:text-violet-200'
  if (v === 'low') return 'bg-sky-500/15 text-sky-900 dark:text-sky-200'
  return 'bg-zinc-500/15 text-zinc-800 dark:text-zinc-300'
}

function parseJsonTaskResult(raw: string): JsonTaskResult | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.ticker === 'string' &&
      typeof parsed.market_view === 'string' &&
      typeof parsed.trend === 'string' &&
      Array.isArray(parsed.key_catalysts) &&
      parsed.key_catalysts.every((x) => typeof x === 'string') &&
      typeof parsed.bull_case === 'string' &&
      typeof parsed.bear_case === 'string' &&
      Array.isArray(parsed.main_risks) &&
      parsed.main_risks.every((x) => typeof x === 'string') &&
      typeof parsed.confidence_level === 'string'
    ) {
      return {
        ticker: parsed.ticker,
        market_view: parsed.market_view,
        trend: parsed.trend,
        key_catalysts: parsed.key_catalysts as string[],
        bull_case: parsed.bull_case,
        bear_case: parsed.bear_case,
        main_risks: parsed.main_risks as string[],
        confidence_level: parsed.confidence_level,
      }
    }
  } catch {
    // Not JSON; caller renders fallback
  }
  return null
}

const RISK_TOLERANCE_PRESETS = [
  'Conservative/Low',
  'Moderate conservative/Low–moderate',
  'Moderate/Medium',
  'Moderate aggressive/Medium–high',
  'Aggressive/High',
  'Speculative/Very high',
] as const

const INVESTMENT_HORIZON_PRESETS = [
  'Under 1 year',
  '1–3 years',
  '3–5 years',
  '5–10 years',
  '10+ years',
  'Retirement/long-term',
] as const

function App() {
  const wsRef = useRef<WebSocket | null>(null)
  const horizonListId = useId()
  const horizonBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const analysisStartRef = useRef<number | null>(null)

  const [ticker, setTicker] = useState('AAPL')
  const [focusQuery, setFocusQuery] = useState('')
  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [wsConnected, setWsConnected] = useState(false)
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([])
  const [crewDeliverables, setCrewDeliverables] = useState<CrewDeliverable[]>([])
  const [agentActivities, setAgentActivities] = useState<AgentActivityItem[]>([])
  const [elapsedSec, setElapsedSec] = useState(0)
  const [lastRunDurationSec, setLastRunDurationSec] = useState<number | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [report, setReport] = useState<FinalReportData | null>(null)
  const [reportRaw, setReportRaw] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [chatQuestion, setChatQuestion] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatAwaitingReply, setChatAwaitingReply] = useState(false)
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const [riskTolerance, setRiskTolerance] = useState('')
  const [investmentHorizon, setInvestmentHorizon] = useState('')
  const [preferencesExtra, setPreferencesExtra] = useState('')
  const [prefsRawPreview, setPrefsRawPreview] = useState<string | null>(null)
  const [prefsReady, setPrefsReady] = useState(false)
  const [prefsLoading, setPrefsLoading] = useState(true)
  const [prefsSaving, setPrefsSaving] = useState(false)
  const [prefsError, setPrefsError] = useState<string | null>(null)
  const [prefsSavedMsg, setPrefsSavedMsg] = useState<string | null>(null)
  const [profileStepCompleted, setProfileStepCompleted] = useState(false)
  const [horizonMenuOpen, setHorizonMenuOpen] = useState(false)
  const [horizonHighlight, setHorizonHighlight] = useState(-1)

  const horizonSuggestions = useMemo(() => {
    const q = investmentHorizon.trim().toLowerCase()
    if (!q) return [...INVESTMENT_HORIZON_PRESETS]
    return INVESTMENT_HORIZON_PRESETS.filter((opt) => opt.toLowerCase().includes(q))
  }, [investmentHorizon])

  const loadPreferences = useCallback(async () => {
    setPrefsLoading(true)
    setPrefsError(null)
    setPrefsSavedMsg(null)
    try {
      const { content } = await fetchPreferences()
      const parsed = parsePreferencesContent(content)
      if (parsed) {
        setRiskTolerance(parsed.risk_tolerance ?? '')
        setInvestmentHorizon(parsed.investment_horizon ?? '')
        setPreferencesExtra(parsed.preferences ?? '')
        setPrefsRawPreview(null)
      } else {
        setRiskTolerance('')
        setInvestmentHorizon('')
        setPreferencesExtra('')
        setPrefsRawPreview(content.trim() || null)
      }
      // Force explicit profile save before analysis.
      setProfileStepCompleted(false)
      setPrefsReady(true)
    } catch (e) {
      setPrefsReady(false)
      setPrefsError(e instanceof Error ? e.message : 'Could not load preferences')
    } finally {
      setPrefsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadPreferences()
  }, [loadPreferences])

  useEffect(() => {
    if (phase !== 'running' && phase !== 'awaiting_feedback') return
    const id = window.setInterval(() => {
      const t = analysisStartRef.current
      if (t != null) setElapsedSec(Math.floor((Date.now() - t) / 1000))
    }, 400)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => {
    if (!prefsSavedMsg) return
    const t = window.setTimeout(() => setPrefsSavedMsg(null), 4800)
    return () => clearTimeout(t)
  }, [prefsSavedMsg])

  const savePreferences = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setPrefsSaving(true)
      setPrefsError(null)
      setPrefsSavedMsg(null)
      try {
        const res = await updatePreferences({
          risk_tolerance: riskTolerance.trim() || 'Not specified',
          investment_horizon: investmentHorizon.trim() || 'Not specified',
          preferences: preferencesExtra.trim() || 'None',
        })
        setProfileStepCompleted(true)
        setPrefsSavedMsg(res.message ?? 'Saved')
        await loadPreferences()
        setProfileStepCompleted(true)
      } catch (err) {
        setPrefsError(err instanceof Error ? err.message : 'Save failed')
      } finally {
        setPrefsSaving(false)
      }
    },
    [investmentHorizon, loadPreferences, preferencesExtra, riskTolerance],
  )

  function openHorizonMenu() {
    if (horizonBlurTimer.current) {
      clearTimeout(horizonBlurTimer.current)
      horizonBlurTimer.current = null
    }
    setHorizonMenuOpen(true)
  }

  function closeHorizonMenuSoon() {
    horizonBlurTimer.current = setTimeout(() => {
      setHorizonMenuOpen(false)
      setHorizonHighlight(-1)
    }, 120)
  }

  function pickHorizonSuggestion(value: string) {
    setInvestmentHorizon(value)
    setProfileStepCompleted(false)
    setHorizonMenuOpen(false)
    setHorizonHighlight(-1)
  }

  function onHorizonKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!horizonMenuOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && horizonSuggestions.length > 0) {
      e.preventDefault()
      setHorizonMenuOpen(true)
      setHorizonHighlight(e.key === 'ArrowDown' ? 0 : horizonSuggestions.length - 1)
      return
    }
    if (!horizonMenuOpen) return

    if (e.key === 'Escape') {
      e.preventDefault()
      setHorizonMenuOpen(false)
      setHorizonHighlight(-1)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHorizonHighlight((i) =>
        horizonSuggestions.length ? Math.min(i + 1, horizonSuggestions.length - 1) : -1,
      )
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHorizonHighlight((i) => (horizonSuggestions.length ? Math.max(i - 1, 0) : -1))
      return
    }
    if (e.key === 'Enter' && horizonHighlight >= 0 && horizonSuggestions[horizonHighlight]) {
      e.preventDefault()
      pickHorizonSuggestion(horizonSuggestions[horizonHighlight])
    }
  }

  const appendLog = useCallback((line: string) => {
    setActivityEntries((prev) => [
      ...prev,
      { id: crypto.randomUUID(), message: line, ts: Date.now() },
    ])
    setAgentActivities((prev) => [
      ...prev,
      { id: crypto.randomUUID(), ts: Date.now(), kind: 'status', message: line },
    ])
  }, [])

  const closeSocket = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
    setWsConnected(false)
  }, [])

  const resetSession = useCallback(() => {
    closeSocket()
    setPhase('idle')
    analysisStartRef.current = null
    setElapsedSec(0)
    setLastRunDurationSec(null)
    setActivityEntries([])
    setCrewDeliverables([])
    setAgentActivities([])
    setDraft(null)
    setFeedback('')
    setReport(null)
    setReportRaw(null)
    setSessionError(null)
    setChatMessages([])
    setChatQuestion('')
    setChatAwaitingReply(false)
    setProfileStepCompleted(false)
    setFocusQuery('')
  }, [closeSocket])

  const handleServerMessage = useCallback(
    (raw: unknown) => {
      const msg = raw as AnalyzeServerMessage
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return

      switch (msg.type) {
        case 'status':
          appendLog(typeof msg.data === 'string' ? msg.data : String(msg.data))
          break
        case 'task_started': {
          const started = msg.data
          if (!isTaskStartedPayload(started)) break
          if (started.task_name === 'format_json_task') break
          setAgentActivities((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              ts: Date.now(),
              kind: 'working',
              task_name: started.task_name,
              agent_role: started.agent_role,
            },
          ])
          break
        }
        case 'task_output': {
          const payload = msg.data
          if (!isTaskOutputPayload(payload)) break
          if (payload.task_name === 'format_json_task') break
          setCrewDeliverables((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              ts: Date.now(),
              task_name: payload.task_name,
              agent_role: payload.agent_role,
              output: payload.output,
              truncated: payload.truncated,
            },
          ])
          setAgentActivities((prev) => {
            const now = Date.now()
            let replaceIdx = -1
            for (let i = prev.length - 1; i >= 0; i--) {
              const it = prev[i]
              if (it.kind === 'working' && it.task_name === payload.task_name) {
                replaceIdx = i
                break
              }
            }
            const row: AgentActivityItem = {
              id: replaceIdx >= 0 ? prev[replaceIdx]!.id : crypto.randomUUID(),
              ts: now,
              kind: 'task_output',
              task_name: payload.task_name,
              agent_role: payload.agent_role,
              output: payload.output,
              truncated: payload.truncated,
            }
            if (replaceIdx === -1) return [...prev, row]
            const next = [...prev]
            next[replaceIdx] = row
            return next
          })
          break
        }
        case 'review_needed':
          setDraft(typeof msg.data === 'string' ? msg.data : String(msg.data))
          setPhase('awaiting_feedback')
          appendLog('Draft ready — please review and send feedback.')
          break
        case 'complete': {
          const data = msg.data
          if (isFinalReportData(data)) {
            setReport(data)
            setReportRaw(null)
          } else if (typeof data === 'string') {
            setReport(null)
            setReportRaw(data)
          } else {
            setReport(null)
            setReportRaw(JSON.stringify(data, null, 2))
          }
          setDraft(null)
          setPhase('done')
          if (analysisStartRef.current != null) {
            setLastRunDurationSec(
              Math.floor((Date.now() - analysisStartRef.current) / 1000),
            )
          }
          appendLog('Analysis complete.')
          break
        }
        case 'error': {
          const errText = typeof msg.data === 'string' ? msg.data : String(msg.data)
          appendLog(`Error: ${errText}`)
          setSessionError(errText)
          setChatAwaitingReply(false)
          setPhase('failed')
          break
        }
        case 'chat_response':
          setChatAwaitingReply(false)
          setChatMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'advisor',
              text: typeof msg.data === 'string' ? msg.data : String(msg.data),
            },
          ])
          break
        default:
          break
      }
    },
    [appendLog],
  )

  const ensureAnalyzeSocket = useCallback((): WebSocket | null => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return wsRef.current
    }
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      return wsRef.current
    }

    const ws = new WebSocket(getAnalyzeWebSocketUrl())
    wsRef.current = ws

    ws.onopen = () => {
      setWsConnected(true)
      setSessionError(null)
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as unknown
        handleServerMessage(parsed)
      } catch {
        appendLog(`(non-JSON message) ${event.data}`)
      }
    }

    ws.onerror = () => {
      setSessionError('WebSocket connection error. Is the backend running on port 8000?')
      setPhase('failed')
      setWsConnected(false)
    }

    ws.onclose = () => {
      setWsConnected(false)
      if (wsRef.current === ws) {
        wsRef.current = null
      }
    }

    return ws
  }, [appendLog, handleServerMessage])

  const sendStart = useCallback(() => {
    const sym = ticker.trim().toUpperCase()
    if (!sym) return

    setSessionError(null)
    setReport(null)
    setReportRaw(null)
    setDraft(null)
    analysisStartRef.current = Date.now()
    setElapsedSec(0)
    setLastRunDurationSec(null)
    setActivityEntries([])
    setCrewDeliverables([])
    setAgentActivities([])
    setChatMessages([])
    setChatAwaitingReply(false)
    setPhase('running')

    const ws = ensureAnalyzeSocket()
    if (!ws) return

    const payload = {
      action: 'start' as const,
      ticker: sym,
      query: focusQuery.trim(),
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload))
      return
    }

    ws.addEventListener(
      'open',
      () => {
        ws.send(JSON.stringify(payload))
      },
      { once: true },
    )
  }, [ensureAnalyzeSocket, focusQuery, ticker])

  const sendFeedback = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSessionError('Not connected. Start analysis again.')
      return
    }
    const message = feedback.trim() || 'Looks good, proceed with the draft as-is.'
    ws.send(JSON.stringify({ action: 'feedback', message }))
    setPhase('running')
    setDraft(null)
    appendLog('Feedback sent. Agents are revising the report…')
  }, [appendLog, feedback])

  const sendChat = useCallback(() => {
    const q = chatQuestion.trim()
    if (!q || chatAwaitingReply) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSessionError('Not connected. Run a new analysis to chat.')
      return
    }

    const context: Record<string, unknown> = report
      ? { ...report }
      : reportRaw
        ? { ticker: ticker.trim().toUpperCase(), raw_report: reportRaw }
        : { ticker: ticker.trim().toUpperCase() }

    ws.send(JSON.stringify({ action: 'chat', question: q, context }))
    setChatAwaitingReply(true)
    setChatMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text: q }])
    setChatQuestion('')
    appendLog(`Chat: ${q}`)
  }, [appendLog, chatAwaitingReply, chatQuestion, report, reportRaw, ticker])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chatMessages, chatAwaitingReply])

  function onChatKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendChat()
    }
  }

  const insertChatSuggestion = useCallback((text: string) => {
    setChatQuestion(text)
  }, [])

  const analysisLocked = !profileStepCompleted
  const showProfileWidget = !profileStepCompleted
  const showAnalysisWidget = profileStepCompleted

  function onStartSubmit(e: FormEvent) {
    e.preventDefault()
    if (analysisLocked) {
      setSessionError('Step 1 required: save Investment profile first.')
      return
    }
    sendStart()
  }

  return (
    <div className="min-h-svh bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
        <section className="rounded-2xl border border-zinc-200/90 bg-white/80 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/70">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`rounded-full px-2.5 py-1 font-semibold ${
                profileStepCompleted
                  ? 'bg-emerald-500/20 text-emerald-900 dark:text-emerald-200'
                  : 'bg-amber-500/20 text-amber-900 dark:text-amber-200'
              }`}
            >
              1. Update profile
            </span>
            <span className="text-zinc-400">→</span>
            <span
              className={`rounded-full px-2.5 py-1 font-semibold ${
                analysisLocked
                  ? 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                  : 'bg-violet-500/20 text-violet-900 dark:text-violet-200'
              }`}
            >
              2. Run analysis
            </span>
            <span className="ml-auto text-zinc-500 dark:text-zinc-400">
              {analysisLocked
                ? 'Save profile to unlock analysis'
                : 'Profile saved — analysis unlocked'}
            </span>
          </div>
        </section>

        {showProfileWidget && (
          <section className="overflow-hidden rounded-3xl border border-zinc-200/90 bg-white shadow-[0_20px_50px_-12px_rgba(109,40,217,0.12)] ring-1 ring-violet-500/5 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.45)] dark:ring-violet-500/10">
          <div className="relative border-b border-zinc-100 bg-linear-to-br from-violet-500/[0.07] via-white to-fuchsia-500/4 px-5 py-5 sm:px-6 dark:border-zinc-800 dark:from-violet-500/10 dark:via-zinc-900 dark:to-fuchsia-500/5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-4">
                <div
                  className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-violet-600/10 text-violet-700 shadow-inner shadow-violet-900/5 dark:bg-violet-500/15 dark:text-violet-300"
                  aria-hidden
                >
                  <svg className="size-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                    />
                  </svg>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-600 dark:text-violet-400">
                  Investment Profile
                  </p>
                  <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    Shapes how the advisor interprets risk and writes reports.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {prefsLoading ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/80 bg-white/90 px-3 py-1.5 text-xs font-medium text-violet-800 shadow-sm dark:border-violet-500/20 dark:bg-zinc-950/80 dark:text-violet-200">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-400 opacity-60" />
                      <span className="relative inline-flex size-2 rounded-full bg-violet-500" />
                    </span>
                    Syncing…
                  </span>
                ) : prefsReady ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/90 bg-emerald-50/90 px-3 py-1.5 text-xs font-semibold text-emerald-900 shadow-sm dark:border-emerald-500/25 dark:bg-emerald-950/50 dark:text-emerald-200">
                    <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]" />
                    In sync
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/90 bg-amber-50/90 px-3 py-1.5 text-xs font-semibold text-amber-950 shadow-sm dark:border-amber-500/25 dark:bg-amber-950/40 dark:text-amber-100">
                    Offline
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4 px-5 py-5 sm:px-6">
            {prefsError && (
              <div
                role="alert"
                className="flex gap-3 rounded-2xl border border-rose-200/90 bg-rose-50/95 px-4 py-3 text-sm text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/50 dark:text-rose-100"
              >
                <span className="text-rose-500 dark:text-rose-400" aria-hidden>
                  <svg className="size-5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                    />
                  </svg>
                </span>
                <span>{prefsError}</span>
              </div>
            )}
            {prefsSavedMsg && (
              <div className="flex gap-3 rounded-2xl border border-emerald-200/90 bg-emerald-50/95 px-4 py-3 text-sm font-medium text-emerald-950 dark:border-emerald-800/50 dark:bg-emerald-950/40 dark:text-emerald-100">
                <span className="text-emerald-600 dark:text-emerald-400" aria-hidden>
                  <svg className="size-5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </span>
                <span>{prefsSavedMsg}</span>
              </div>
            )}
            {prefsRawPreview && !prefsLoading && (
              <p className="rounded-xl border border-amber-200/70 bg-amber-50/50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/25 dark:text-amber-100/90">
                This file uses a non-standard layout. Raw content is shown below the form.
              </p>
            )}

            <form onSubmit={savePreferences} className="space-y-5">
              <div className="rounded-2xl border border-zinc-100 bg-zinc-50/50 p-4 dark:border-zinc-800/80 dark:bg-zinc-950/40">
                <p className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                  <span className="h-px flex-1 bg-linear-to-r from-transparent via-zinc-300 to-transparent dark:via-zinc-600" />
                  Risk and time horizon
                  <span className="h-px flex-1 bg-linear-to-r from-transparent via-zinc-300 to-transparent dark:via-zinc-600" />
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="group flex flex-col gap-1.5">
                    <label
                      htmlFor="risk-tolerance"
                      className="text-xs font-semibold text-zinc-700 dark:text-zinc-300"
                    >
                      Risk Tolerance
                    </label>
                    <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                      Controls recommendation aggressiveness.
                    </p>
                    <select
                      id="risk-tolerance"
                      value={riskTolerance}
                      onChange={(e) => {
                        setRiskTolerance(e.target.value)
                        setProfileStepCompleted(false)
                      }}
                      disabled={prefsLoading}
                      className="mt-0.5 w-full cursor-pointer appearance-none rounded-xl border border-zinc-200 bg-white py-2.5 pl-3 pr-9 text-sm text-zinc-900 shadow-sm outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-violet-400"
                      style={{
                        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2371717a'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
                        backgroundRepeat: 'no-repeat',
                        backgroundPosition: 'right 0.65rem center',
                        backgroundSize: '1rem',
                      }}
                    >
                      <option value="">Choose a profile…</option>
                      {RISK_TOLERANCE_PRESETS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                      {riskTolerance &&
                        !(RISK_TOLERANCE_PRESETS as readonly string[]).includes(riskTolerance) && (
                          <option value={riskTolerance}>
                            {riskTolerance} (from saved profile)
                          </option>
                        )}
                    </select>
                  </div>
                  <div className="relative flex flex-col gap-1.5">
                    <label
                      htmlFor="investment-horizon"
                      className="text-xs font-semibold text-zinc-700 dark:text-zinc-300"
                    >
                      Investment horizon
                    </label>
                    <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                      Pick a preset or type freely — both are saved.
                    </p>
                    <input
                      id="investment-horizon"
                      type="text"
                      role="combobox"
                      aria-expanded={horizonMenuOpen}
                      aria-controls={horizonListId}
                      aria-autocomplete="list"
                      value={investmentHorizon}
                      onChange={(e) => {
                        setInvestmentHorizon(e.target.value)
                        setProfileStepCompleted(false)
                        setHorizonHighlight(-1)
                        openHorizonMenu()
                      }}
                      onFocus={openHorizonMenu}
                      onBlur={closeHorizonMenuSoon}
                      onKeyDown={onHorizonKeyDown}
                      placeholder="e.g. 3–5 years or start typing…"
                      autoComplete="off"
                      disabled={prefsLoading}
                      className="mt-0.5 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                    />
                    {horizonMenuOpen && !prefsLoading && (
                      <ul
                        id={horizonListId}
                        role="listbox"
                        className="absolute left-0 right-0 top-full z-30 mt-1 max-h-52 overflow-auto rounded-xl border border-zinc-200/90 bg-white py-1 shadow-xl shadow-zinc-900/10 ring-1 ring-black/5 dark:border-zinc-600 dark:bg-zinc-900 dark:shadow-black/30 dark:ring-white/5"
                      >
                        {horizonSuggestions.length === 0 ? (
                          <li className="px-3 py-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                            No preset matches — your text will still be saved.
                          </li>
                        ) : (
                          horizonSuggestions.map((opt, idx) => (
                            <li key={opt} role="option" aria-selected={idx === horizonHighlight}>
                              <button
                                type="button"
                                className={`flex w-full px-3 py-2.5 text-left text-sm text-zinc-800 transition hover:bg-violet-50 dark:text-zinc-100 dark:hover:bg-violet-950/50 ${
                                  idx === horizonHighlight
                                    ? 'bg-violet-100 dark:bg-violet-950/70'
                                    : ''
                                }`}
                                onMouseDown={(ev) => ev.preventDefault()}
                                onClick={() => pickHorizonSuggestion(opt)}
                              >
                                {opt}
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-100 bg-zinc-50/50 p-4 dark:border-zinc-800/80 dark:bg-zinc-950/40">
                <p className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                  <span className="h-px flex-1 bg-linear-to-r from-transparent via-zinc-300 to-transparent dark:via-zinc-600" />
                  Voice and constraints
                  <span className="h-px flex-1 bg-linear-to-r from-transparent via-zinc-300 to-transparent dark:via-zinc-600" />
                </p>
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="style-preferences"
                    className="text-xs font-semibold text-zinc-700 dark:text-zinc-300"
                  >
                    Style and extra preferences
                  </label>
                  <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                    Tone, sectors, length, or anything the advisor should respect.
                  </p>
                  <textarea
                    id="style-preferences"
                    value={preferencesExtra}
                    onChange={(e) => {
                      setPreferencesExtra(e.target.value)
                      setProfileStepCompleted(false)
                    }}
                    placeholder="e.g. Keep bullets short; avoid hype; prefer dividend names…"
                    rows={4}
                    disabled={prefsLoading}
                    className="mt-0.5 min-h-22 w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="submit"
                  disabled={prefsLoading || prefsSaving}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-violet-500/25 transition hover:from-violet-500 hover:to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/20 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none sm:w-auto dark:shadow-violet-900/30"
                >
                  {prefsSaving ? (
                    <SearchSpinner className="size-4 border-white border-t-transparent" />
                  ) : (
                    <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 12.75l6 6 9-13.5"
                      />
                    </svg>
                  )}
                  Save Profile
                </button>
              </div>
            </form>

            {prefsRawPreview && (
              <details className="group rounded-2xl border border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-950/60">
                <summary className="cursor-pointer list-none px-4 py-3 text-xs font-semibold text-zinc-600 marker:hidden dark:text-zinc-400 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center justify-between gap-2">
                    Raw file preview
                    <span className="text-[10px] font-normal text-zinc-400 group-open:hidden dark:text-zinc-500">
                      Show
                    </span>
                    <span className="hidden text-[10px] font-normal text-zinc-400 group-open:inline dark:text-zinc-500">
                      Hide
                    </span>
                  </span>
                </summary>
                <pre className="max-h-48 overflow-auto border-t border-zinc-200 p-4 font-mono text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
                  {prefsRawPreview}
                </pre>
              </details>
            )}
          </div>
          </section>
        )}

        {showAnalysisWidget && (
          <section className="overflow-hidden rounded-3xl border border-zinc-200/90 bg-white shadow-[0_20px_50px_-12px_rgba(109,40,217,0.1)] ring-1 ring-violet-500/5 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.4)] dark:ring-violet-500/10">
          <div className="relative border-b border-zinc-100 bg-linear-to-br from-violet-600/10 via-white to-fuchsia-500/5 px-5 py-6 sm:px-6 dark:border-zinc-800 dark:from-violet-500/15 dark:via-zinc-900 dark:to-fuchsia-500/8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex gap-4">
                <div
                  className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-linear-to-br from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-500/30"
                  aria-hidden
                >
                  <svg className="size-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6"
                    />
                  </svg>
                </div>
                <div>
                  <p className="text-lg font-semibold tracking-tight text-violet-700 dark:text-violet-300">
                    Agentic Stock Analyst
                  </p>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    Multi-agent research, a review pause for your feedback, then structured JSON — with a live trace of
                    what the crew is doing.
                  </p>
                  <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
                    <li>Set ticker and optional focus, then run.</li>
                    <li>Review the draft and send feedback (or approve).</li>
                    <li>Chat with the advisor after the report is ready.</li>
                  </ol>
                </div>
              </div>
              <div className="flex flex-col gap-2 rounded-2xl border border-white/60 bg-white/70 px-4 py-3 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-950/60">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                    Session
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      analysisLocked
                        ? 'bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                        : phase === 'running'
                        ? 'bg-violet-500/20 text-violet-800 dark:bg-violet-500/25 dark:text-violet-200'
                        : phase === 'awaiting_feedback'
                          ? 'bg-amber-500/20 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100'
                          : phase === 'done'
                            ? 'bg-emerald-500/20 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-100'
                            : phase === 'failed'
                              ? 'bg-rose-500/20 text-rose-900 dark:bg-rose-500/20 dark:text-rose-100'
                              : 'bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {analysisLocked ? 'Profile required' : analysisPhaseLabel(phase)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                  {wsConnected ? (
                    <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                      <span className="relative flex size-2">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-40" />
                        <span className="relative size-2 rounded-full bg-emerald-500" />
                      </span>
                      Live channel
                    </span>
                  ) : phase === 'running' || phase === 'awaiting_feedback' ? (
                    <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                      <SearchSpinner className="size-3 border-amber-600 border-t-transparent dark:border-amber-400" />
                      Connecting…
                    </span>
                  ) : (
                    <span className="text-zinc-500">Channel idle</span>
                  )}
                  {(phase === 'running' || phase === 'awaiting_feedback') && (
                    <span className="tabular-nums text-violet-700 dark:text-violet-300">
                      Elapsed {formatDuration(elapsedSec)}
                    </span>
                  )}
                  {phase === 'done' && lastRunDurationSec != null && (
                    <span className="tabular-nums text-zinc-500">
                      Finished in {formatDuration(lastRunDurationSec)}
                    </span>
                  )}
                </div>
                {(phase === 'running' || phase === 'awaiting_feedback') && (
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-zinc-200/90 dark:bg-zinc-800"
                    aria-hidden
                  >
                    <div className="h-full w-3/5 animate-pulse rounded-full bg-linear-to-r from-violet-500 to-fuchsia-500" />
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-5 px-5 py-5 sm:px-6">
            <form onSubmit={onStartSubmit} className="space-y-4">
              <div className="rounded-2xl border border-zinc-100 bg-zinc-50/50 p-4 dark:border-zinc-800/80 dark:bg-zinc-950/40">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                  Run configuration
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5 sm:col-span-1">
                    <label
                      htmlFor="analysis-ticker"
                      className="text-xs font-semibold text-zinc-700 dark:text-zinc-300"
                    >
                      Ticker
                    </label>
                    <input
                      id="analysis-ticker"
                      type="text"
                      value={ticker}
                      onChange={(e) => setTicker(e.target.value.toUpperCase())}
                      placeholder="e.g. TSLA"
                      disabled={analysisLocked || phase === 'running' || phase === 'awaiting_feedback'}
                      className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base font-semibold tabular-nums tracking-wide outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <label
                      htmlFor="analysis-focus"
                      className="text-xs font-semibold text-zinc-700 dark:text-zinc-300"
                    >
                      Research focus{' '}
                      <span className="font-normal text-zinc-500">(optional)</span>
                    </label>
                    <textarea
                      id="analysis-focus"
                      value={focusQuery}
                      onChange={(e) => setFocusQuery(e.target.value)}
                      placeholder="What should the crew emphasize? Catalysts, valuation, risks, comparables…"
                      rows={3}
                      disabled={analysisLocked || phase === 'running' || phase === 'awaiting_feedback'}
                      className="w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                  </div>
                </div>
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                  <button
                    type="submit"
                    disabled={
                      analysisLocked ||
                      !ticker.trim() ||
                      phase === 'running' ||
                      phase === 'awaiting_feedback'
                    }
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-linear-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-violet-500/25 transition hover:from-violet-500 hover:to-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none sm:flex-none dark:shadow-violet-900/30"
                  >
                    {(phase === 'running' || phase === 'awaiting_feedback') && (
                      <SearchSpinner className="size-4 border-white border-t-transparent" />
                    )}
                    {phase === 'running'
                      ? 'Analysis in progress…'
                      : phase === 'awaiting_feedback'
                        ? 'Waiting for your review…'
                        : analysisLocked
                          ? 'Complete profile first'
                          : 'Run analysis'}
                  </button>
                  <button
                    type="button"
                    onClick={resetSession}
                    className="rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 shadow-sm transition hover:border-violet-300 hover:bg-violet-50/40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-violet-500/30"
                  >
                    New session
                  </button>
                </div>
                {analysisLocked && (
                  <p className="mt-3 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
                    Step 2 is locked. Update and save your Investment profile first.
                  </p>
                )}
              </div>
            </form>

            {sessionError && (
              <div
                role="alert"
                className="flex gap-3 rounded-2xl border border-rose-200/90 bg-rose-50/95 px-4 py-3 text-sm text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/50 dark:text-rose-100"
              >
                <svg className="size-5 shrink-0 text-rose-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                  />
                </svg>
                <span>{sessionError}</span>
              </div>
            )}

            {(activityEntries.length > 0 ||
              crewDeliverables.length > 0 ||
              phase === 'running' ||
              phase === 'awaiting_feedback') && (
              <div className="overflow-hidden rounded-2xl border border-zinc-200/90 bg-linear-to-b from-violet-50/35 via-zinc-50/30 to-zinc-50/40 dark:border-zinc-800 dark:from-violet-950/20 dark:via-zinc-950/40 dark:to-zinc-950/50">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 px-4 py-3 dark:border-zinc-800">
                  <div>
                    <h2 className="text-xs font-bold uppercase tracking-widest text-violet-800 dark:text-violet-300">
                      Agents activities
                    </h2>
                    <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                      Each task shows who is working first; the row updates in place when the result arrives.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(phase === 'running' || phase === 'awaiting_feedback') && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
                        <span className="size-1.5 animate-pulse rounded-full bg-violet-500" />
                        Live
                      </span>
                    )}
                    <span className="rounded-full bg-zinc-200/80 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                      {agentActivities.length} item{agentActivities.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>

                <div className="p-3">
                  {agentActivities.length === 0 &&
                    (phase === 'running' || phase === 'awaiting_feedback') && (
                      <p className="px-2 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        <span className="inline-flex items-center gap-2">
                          <SearchSpinner className="size-4" />
                          Waiting for activity from the crew…
                        </span>
                      </p>
                    )}
                  <ul className="divide-y divide-zinc-200/70 dark:divide-zinc-800">
                    {agentActivities.map((item, i) => {
                      if (item.kind === 'task_output' && item.task_name === 'format_json_task') {
                        return null
                      }
                      const isLatest = i === agentActivities.length - 1
                      const livePulse =
                        isLatest && (phase === 'running' || phase === 'awaiting_feedback')
                      if (item.kind === 'working') {
                        return (
                          <li key={item.id} className="py-3">
                            <div className="flex gap-3 px-1">
                              <time
                                className="shrink-0 tabular-nums text-[10px] font-medium text-zinc-400 dark:text-zinc-500"
                                dateTime={new Date(item.ts).toISOString()}
                              >
                                {new Date(item.ts).toLocaleTimeString(undefined, {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })}
                              </time>
                              <div className="min-w-0 flex-1">
                                {/* <p className="text-sm font-semibold leading-snug text-zinc-900 dark:text-white">
                                  {item.agent_role}
                                </p> */}
                                <p className="mt-1 flex items-center gap-2 text-xs leading-snug text-zinc-600 dark:text-zinc-400">
                                  <SearchSpinner className="size-3.5" />
                                  <span>
                                    <span className="font-medium text-zinc-800 dark:text-zinc-200">
                                      {formatCrewTaskTitle(item.task_name)} is working.
                                    </span>
                                    …
                                  </span>
                                </p>
                              </div>
                              {livePulse && (
                                <span
                                  className="mt-1 size-2 shrink-0 rounded-full bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.8)]"
                                  aria-hidden
                                />
                              )}
                            </div>
                          </li>
                        )
                      }
                      if (item.kind === 'status') {
                        return (
                          <li key={item.id} className="py-2.5">
                            <div className="flex gap-3 px-1">
                              <time
                                className="shrink-0 tabular-nums text-[10px] font-medium text-zinc-400 dark:text-zinc-500"
                                dateTime={new Date(item.ts).toISOString()}
                              >
                                {new Date(item.ts).toLocaleTimeString(undefined, {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })}
                              </time>
                              <p className="min-w-0 flex-1 text-sm leading-snug text-zinc-800 dark:text-zinc-200">
                                {item.message}
                              </p>
                              {livePulse && (
                                <span
                                  className="mt-0.5 size-2 shrink-0 rounded-full bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.8)]"
                                  aria-hidden
                                />
                              )}
                            </div>
                          </li>
                        )
                      }
                      const parsedPriceTask =
                        item.task_name === 'analyze_price_task'
                          ? parsePriceTaskResult(item.output)
                          : null
                      const parsedJsonTask =
                        item.task_name === 'format_json_task'
                          ? parseJsonTaskResult(item.output)
                          : null
                      return (
                        <li key={item.id} className="py-3">
                          <div>
                            <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-0.5">
                              <span className="inline-flex items-center gap-2 min-w-0 font-semibold text-zinc-900 dark:text-white">
                                <span className="size-1.5 rounded-full bg-violet-500" aria-hidden />
                                {formatCrewTaskTitle(item.task_name)}
                              </span>
                            </div>
                            <div className="px-1 pb-0 pt-2">
                              {item.truncated && (
                                <p className="mb-2 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                                  Output was truncated for the browser; full text may be in server logs.
                                </p>
                              )}
                              {parsedPriceTask ? (
                                <div className="space-y-3 rounded-xl bg-zinc-50/70 p-3 dark:bg-zinc-900/40">
                                  <div className="grid gap-2 sm:grid-cols-3">
                                    <div className="rounded-lg bg-white/90 px-2.5 py-2 dark:bg-zinc-950/70">
                                      <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                                        Trend
                                      </p>
                                      <span
                                        className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${trendBadgeStyles(
                                          parsedPriceTask.trend,
                                        )}`}
                                      >
                                        {parsedPriceTask.trend}
                                      </span>
                                    </div>
                                    <div className="rounded-lg bg-white/90 px-2.5 py-2 dark:bg-zinc-950/70">
                                      <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                                        30D Change
                                      </p>
                                      <p
                                        className={`mt-1 text-sm font-semibold tabular-nums ${
                                          parsedPriceTask.price_change_30d > 0
                                            ? 'text-emerald-700 dark:text-emerald-300'
                                            : parsedPriceTask.price_change_30d < 0
                                              ? 'text-rose-700 dark:text-rose-300'
                                              : 'text-zinc-700 dark:text-zinc-300'
                                        }`}
                                      >
                                        {parsedPriceTask.price_change_30d > 0 ? '+' : ''}
                                        {parsedPriceTask.price_change_30d.toFixed(2)}%
                                      </p>
                                    </div>
                                    <div className="rounded-lg bg-white/90 px-2.5 py-2 dark:bg-zinc-950/70">
                                      <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                                        Volume
                                      </p>
                                      <span
                                        className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${volumeBadgeStyles(
                                          parsedPriceTask.volume_signal,
                                        )}`}
                                      >
                                        {parsedPriceTask.volume_signal}
                                      </span>
                                    </div>
                                  </div>
                                  <p className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">
                                    {parsedPriceTask.summary}
                                  </p>
                                </div>
                              ) : parsedJsonTask ? (
                                <div className="space-y-3 rounded-xl bg-zinc-50/70 p-3 dark:bg-zinc-900/40">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-white">
                                      {parsedJsonTask.ticker}
                                    </span>
                                    <span
                                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${trendBadgeStyles(
                                        parsedJsonTask.trend,
                                      )}`}
                                    >
                                      {parsedJsonTask.trend}
                                    </span>
                                    <span className="inline-flex rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-semibold text-violet-900 dark:text-violet-200">
                                      Confidence: {parsedJsonTask.confidence_level}
                                    </span>
                                  </div>
                                  <div className="rounded-lg bg-white/90 px-2.5 py-2 dark:bg-zinc-950/70">
                                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                                      Market view
                                    </p>
                                    <p className="mt-1 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">
                                      {parsedJsonTask.market_view}
                                    </p>
                                  </div>
                                  <div className="grid gap-2 sm:grid-cols-2">
                                    <div className="rounded-lg bg-emerald-500/10 px-2.5 py-2">
                                      <p className="text-[10px] uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
                                        Bull case
                                      </p>
                                      <p className="mt-1 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">
                                        {parsedJsonTask.bull_case}
                                      </p>
                                    </div>
                                    <div className="rounded-lg bg-rose-500/10 px-2.5 py-2">
                                      <p className="text-[10px] uppercase tracking-wide text-rose-800 dark:text-rose-300">
                                        Bear case
                                      </p>
                                      <p className="mt-1 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">
                                        {parsedJsonTask.bear_case}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="rounded-lg bg-white/90 px-2.5 py-2 dark:bg-zinc-950/70">
                                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                                      Key catalysts
                                    </p>
                                    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">
                                      {parsedJsonTask.key_catalysts.map((c, idx) => (
                                        <li key={`${idx}-${c.slice(0, 20)}`}>{c}</li>
                                      ))}
                                    </ul>
                                  </div>
                                  <div className="rounded-lg bg-white/90 px-2.5 py-2 dark:bg-zinc-950/70">
                                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                                      Main risks
                                    </p>
                                    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">
                                      {parsedJsonTask.main_risks.map((r, idx) => (
                                        <li key={`${idx}-${r.slice(0, 20)}`}>{r}</li>
                                      ))}
                                    </ul>
                                  </div>
                                </div>
                              ) : (
                                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
                                  {item.output}
                                </pre>
                              )}
                              <time
                                className="mt-2 block text-[10px] font-medium text-zinc-400 dark:text-zinc-500"
                                dateTime={new Date(item.ts).toISOString()}
                              >
                                {new Date(item.ts).toLocaleTimeString(undefined, {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })}
                              </time>
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>

                </div>
              </div>
            )}
          </div>
          </section>
        )}

        {draft !== null && phase === 'awaiting_feedback' && (
          <section className="flex flex-col gap-4 overflow-hidden rounded-3xl border border-amber-200/80 bg-linear-to-br from-amber-50/90 to-white p-6 shadow-lg shadow-amber-900/5 dark:border-amber-900/45 dark:from-amber-950/35 dark:to-zinc-900 dark:shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-amber-950 dark:text-amber-100">
                Your review
              </h2>
              <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
                Human in the loop
              </span>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-amber-200/60 bg-white/80 p-4 text-sm text-zinc-800 dark:border-amber-900/30 dark:bg-zinc-950 dark:text-zinc-200">
              {draft}
            </pre>
            <label className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Your feedback
            </label>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g. Shorter bullets, expand risks, tone down hype…"
              rows={4}
              className="w-full resize-y rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="button"
              onClick={sendFeedback}
              className="self-start rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-amber-500 dark:bg-amber-500 dark:hover:bg-amber-400"
            >
              Submit feedback
            </button>
          </section>
        )}

        {(report || reportRaw) && phase === 'done' && (
          <section className="flex flex-col gap-4 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900/80 dark:shadow-none">
            <div className="border-b border-zinc-100 bg-linear-to-br from-violet-500/10 via-transparent to-transparent px-6 py-5 dark:border-zinc-800">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
                Final report
                {report && (
                  <span className="ml-2 tabular-nums text-violet-600 dark:text-violet-400">
                    {report.ticker}
                  </span>
                )}
              </h2>
              {report && (
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Confidence: {report.confidence_level} · Trend: {report.trend}
                  {lastRunDurationSec != null && (
                    <span className="text-zinc-500">
                      {' '}
                      · Run time {formatDuration(lastRunDurationSec)}
                    </span>
                  )}
                </p>
              )}
            </div>

            {report ? (
              <div className="grid gap-4 px-6 pb-6">
                <div className="rounded-xl border border-zinc-100 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Market view
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                    {report.market_view}
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-zinc-100 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                      Bull case
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                      {report.bull_case}
                    </p>
                  </div>
                  <div className="rounded-xl border border-zinc-100 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
                      Bear case
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                      {report.bear_case}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-100 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Key catalysts
                  </h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-800 dark:text-zinc-200">
                    {report.key_catalysts.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-zinc-100 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Main risks
                  </h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-800 dark:text-zinc-200">
                    {report.main_risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <pre className="max-h-96 overflow-auto px-6 pb-6 text-xs text-zinc-700 dark:text-zinc-300">
                {reportRaw}
              </pre>
            )}
          </section>
        )}

        {phase === 'done' && (report || reportRaw) && (
          <section className="overflow-hidden rounded-3xl border border-zinc-200/90 bg-white shadow-[0_20px_50px_-12px_rgba(109,40,217,0.1)] ring-1 ring-violet-500/5 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.4)] dark:ring-violet-500/10">
            <div className="relative border-b border-zinc-100 bg-linear-to-br from-violet-500/8 via-white to-teal-500/5 px-5 py-5 sm:px-6 dark:border-zinc-800 dark:from-violet-500/12 dark:via-zinc-900 dark:to-teal-500/8">
              <div className="flex flex-wrap items-start gap-4">
                <div
                  className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-violet-600/15 text-violet-700 shadow-inner dark:bg-violet-500/20 dark:text-violet-200"
                  aria-hidden
                >
                  <svg className="size-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
                    />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">
                    Advisor chat
                  </h2>
                  <p className="mt-1 max-w-lg text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    Follow-ups use your completed report as context. Press{' '}
                    <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      Enter
                    </kbd>{' '}
                    to send,{' '}
                    <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      Shift+Enter
                    </kbd>{' '}
                    for a new line.
                  </p>
                </div>
                {wsConnected ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-900 dark:text-amber-200">
                    <span className="size-1.5 rounded-full bg-amber-500" />
                    Reconnect to send
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-4 p-5 sm:p-6">
              <div className="flex max-h-72 min-h-40 flex-col gap-3 overflow-y-auto rounded-2xl bg-zinc-50/90 p-4 dark:bg-zinc-950/50">
                {chatMessages.length === 0 && !chatAwaitingReply ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center">
                    <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                      Ask anything about the report—risk, catalysts, or how it fits your goals.
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {CHAT_SUGGESTIONS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => insertChatSuggestion(s)}
                          className="rounded-full border border-violet-200/80 bg-white px-3 py-1.5 text-left text-xs font-medium text-violet-800 shadow-sm transition hover:border-violet-300 hover:bg-violet-50 dark:border-violet-800/60 dark:bg-zinc-900 dark:text-violet-200 dark:hover:bg-violet-950/40"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    {chatMessages.map((m) => (
                      <div
                        key={m.id}
                        className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                      >
                        <div
                          className={`flex size-8 shrink-0 items-center justify-center rounded-xl text-[10px] font-bold ${
                            m.role === 'user'
                              ? 'bg-violet-600 text-white shadow-sm shadow-violet-900/20'
                              : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
                          }`}
                          aria-hidden
                        >
                          {m.role === 'user' ? 'You' : 'AI'}
                        </div>
                        <div
                          className={`max-w-[min(100%,28rem)] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                            m.role === 'user'
                              ? 'bg-linear-to-br from-violet-600 to-violet-700 text-white dark:from-violet-600 dark:to-violet-800'
                              : 'border border-zinc-200/80 bg-white text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100'
                          }`}
                        >
                          <p className="whitespace-pre-wrap wrap-break-word">{m.text}</p>
                        </div>
                      </div>
                    ))}
                    {chatAwaitingReply && (
                      <div className="flex gap-3">
                        <div
                          className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-zinc-200 text-[10px] font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                          aria-hidden
                        >
                          AI
                        </div>
                        <div className="rounded-2xl border border-zinc-200/80 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900">
                          <ChatTypingIndicator />
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </>
                )}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="sr-only" htmlFor="advisor-chat-input">
                  Message to advisor
                </label>
                <textarea
                  id="advisor-chat-input"
                  value={chatQuestion}
                  onChange={(e) => setChatQuestion(e.target.value)}
                  onKeyDown={onChatKeyDown}
                  placeholder="Ask about the report…"
                  rows={2}
                  disabled={chatAwaitingReply}
                  className="min-h-22 flex-1 resize-y rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm leading-relaxed text-zinc-900 shadow-inner shadow-zinc-900/5 outline-none transition placeholder:text-zinc-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-violet-500"
                />
                <button
                  type="button"
                  onClick={sendChat}
                  disabled={!chatQuestion.trim() || chatAwaitingReply || !wsConnected}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-2xl bg-zinc-900 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-zinc-900/15 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-violet-600 dark:shadow-violet-900/25 dark:hover:bg-violet-500"
                >
                  {chatAwaitingReply ? (
                    <>
                      <SearchSpinner className="size-4 border-white border-t-transparent dark:border-white dark:border-t-transparent" />
                      Sending…
                    </>
                  ) : (
                    'Send'
                  )}
                </button>
              </div>
            </div>
          </section>
        )}

        <p className="text-center text-xs text-zinc-500 dark:text-zinc-500">
          Multi-agent pipeline for financial advice.
        </p>
      </div>
    </div>
  )
}

export default App
