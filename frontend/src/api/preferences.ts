const base = import.meta.env.VITE_API_BASE ?? ''

export type UserPreferencesPayload = {
  risk_tolerance: string
  investment_horizon: string
  preferences: string
}

export type PreferencesGetResponse = {
  content: string
}

/** Parse `knowledge/user_preference.txt` shape returned by GET /api/preferences */
export function parsePreferencesContent(content: string): Partial<UserPreferencesPayload> | null {
  const trimmed = content.trim()
  if (!trimmed || /^no preferences set\.?$/i.test(trimmed)) {
    return null
  }

  const risk = trimmed.match(/-\s*Risk Tolerance:\s*(.+?)(?=\n-|\n*$)/is)
  const horizon = trimmed.match(/-\s*Horizon:\s*(.+?)(?=\n-|\n*$)/is)
  const prefs = trimmed.match(/-\s*Preferences:\s*([\s\S]+)$/is)

  if (!risk && !horizon && !prefs) {
    return null
  }

  return {
    risk_tolerance: risk?.[1]?.trim() ?? '',
    investment_horizon: horizon?.[1]?.trim() ?? '',
    preferences: prefs?.[1]?.trim() ?? '',
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  let detail = res.statusText
  try {
    const body = (await res.json()) as { detail?: string }
    if (body.detail) detail = body.detail
  } catch {
    /* ignore */
  }
  return detail || `Request failed (${res.status})`
}

export async function fetchPreferences(): Promise<PreferencesGetResponse> {
  const res = await fetch(`${base}/api/preferences`)
  if (!res.ok) {
    throw new Error(await readErrorMessage(res))
  }
  return res.json() as Promise<PreferencesGetResponse>
}

export async function updatePreferences(
  body: UserPreferencesPayload,
): Promise<{ status: string; message: string }> {
  const res = await fetch(`${base}/api/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res))
  }
  return res.json() as Promise<{ status: string; message: string }>
}
