export type FinalReportData = {
  ticker: string
  market_view: string
  trend: string
  key_catalysts: string[]
  bull_case: string
  bear_case: string
  main_risks: string[]
  confidence_level: string
}

export type TaskOutputPayload = {
  task_name: string
  agent_role: string
  output: string
  truncated?: boolean
}

export type AnalyzeServerMessage =
  | { type: 'status'; data: string }
  | { type: 'review_needed'; data: string }
  | { type: 'complete'; data: FinalReportData | string | Record<string, unknown> }
  | { type: 'error'; data: string }
  | { type: 'chat_response'; data: string }
  | { type: 'task_output'; data: TaskOutputPayload }

export function isTaskOutputPayload(data: unknown): data is TaskOutputPayload {
  if (typeof data !== 'object' || data === null) return false
  const o = data as Record<string, unknown>
  return (
    typeof o.task_name === 'string' &&
    typeof o.agent_role === 'string' &&
    typeof o.output === 'string'
  )
}

export function isFinalReportData(data: unknown): data is FinalReportData {
  if (typeof data !== 'object' || data === null) return false
  const o = data as Record<string, unknown>
  return (
    typeof o.ticker === 'string' &&
    typeof o.market_view === 'string' &&
    Array.isArray(o.key_catalysts)
  )
}
