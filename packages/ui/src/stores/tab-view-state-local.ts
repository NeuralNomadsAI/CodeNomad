import { clientStateIsPrimary, readClientLayoutValue, writeClientLayoutValue } from "./client-state"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import { LEGACY_SESSION_PREVIEWS_KEY, MAX_TAB_PREVIEW_STORAGE, normalizeTabViewState, parseLegacySessionPreviews,
  type RestorableTabViewState } from "./tab-view-state-codec"

const KEY = "opencode-session-tab-views-v1"
const scopes = new Map<string, string>()
const MAX_STORAGE = 64 * 1024

function read(): Record<string, RestorableTabViewState> {
  try {
    const text = window.localStorage.getItem(KEY)
    if (!text || text.length > MAX_STORAGE) return {}
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const budget = { remaining: MAX_TAB_PREVIEW_STORAGE }
    return Object.fromEntries(Object.entries(value).slice(-32).flatMap(([key, value]) => {
      const view = normalizeTabViewState(value, budget)
      return view ? [[key, view]] : []
    }))
  } catch { return {} }
}

export function bindLocalTabView(instanceId: string, folder: string, occurrence: number) {
  const key = JSON.stringify([normalizeWorkspacePath(folder), occurrence])
  scopes.set(instanceId, key)
  return clientStateIsPrimary() ? undefined : read()[key]
}

export function saveLocalTabView(instanceId: string, view?: RestorableTabViewState) {
  if (clientStateIsPrimary()) return
  const key = scopes.get(instanceId)
  if (!key) return
  const values = read()
  delete values[key]
  if (view) values[key] = view
  const budget = { remaining: MAX_TAB_PREVIEW_STORAGE }
  const entries = Object.entries(values).slice(-32).reverse().flatMap(([key, value]) => {
    const normalized = normalizeTabViewState(value, budget)
    return normalized ? [[key, normalized]] : []
  }).reverse()
  while (entries.length && JSON.stringify(Object.fromEntries(entries)).length > MAX_STORAGE) entries.shift()
  try { window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries))) } catch { /* Best-effort layout persistence. */ }
}

export function unbindLocalTabView(instanceId: string) { scopes.delete(instanceId) }

/** Native snapshots migrate by descriptor order; web clients adopt on explicit opening. */
export function adoptLocalLegacyPreview(instanceId: string, sessionId: string): RestorableTabViewState | undefined {
  if (clientStateIsPrimary()) return
  const scope = scopes.get(instanceId)
  if (!scope) return
  const [folder] = JSON.parse(scope) as [string, number]
  const entries = parseLegacySessionPreviews(readClientLayoutValue(LEGACY_SESSION_PREVIEWS_KEY))
  let adopted: RestorableTabViewState | undefined
  const remaining = entries.filter(([key, preview]) => {
    let path = key, session: string | undefined
    try {
      const tuple: unknown = JSON.parse(key)
      if (Array.isArray(tuple) && tuple.length === 2 && tuple.every(part => typeof part === "string")) [path, session] = tuple
    } catch { /* A project-wide record uses its folder directly. */ }
    if (normalizeWorkspacePath(path) !== folder || session !== undefined && session !== sessionId) return true
    adopted = { version: 1, previews: { [sessionId]: preview } }
    return false
  })
  if (adopted) writeClientLayoutValue(LEGACY_SESSION_PREVIEWS_KEY, JSON.stringify(Object.fromEntries(remaining)))
  return adopted
}
