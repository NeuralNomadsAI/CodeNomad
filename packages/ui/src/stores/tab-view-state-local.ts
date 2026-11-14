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

export function bindLocalTabView(instanceId: string, folder: string) {
  const path = normalizeWorkspacePath(folder)
  // Allocation and closure share the bound inventory, including while backend DELETE is pending.
  const occurrence = [...scopes.values()].filter(key => JSON.parse(key)[0] === path).length
  const key = scopes.get(instanceId) ?? JSON.stringify([path, occurrence])
  scopes.set(instanceId, key)
  return clientStateIsPrimary() ? undefined : read()[key]
}

export function saveLocalTabView(instanceId: string, view?: RestorableTabViewState) {
  if (clientStateIsPrimary()) return false
  const key = scopes.get(instanceId)
  if (!key) return false
  const values = read()
  delete values[key]
  if (view) values[key] = view
  const budget = { remaining: MAX_TAB_PREVIEW_STORAGE }
  const entries = Object.entries(values).slice(-32).reverse().flatMap(([key, value]) => {
    const normalized = normalizeTabViewState(value, budget)
    return normalized ? [[key, normalized]] : []
  }).reverse()
  while (entries.length && JSON.stringify(Object.fromEntries(entries)).length > MAX_STORAGE) entries.shift()
  try { window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries))); return true }
  catch { return false }
}

export function unbindLocalTabView(instanceId: string) {
  const scope = scopes.get(instanceId)
  scopes.delete(instanceId)
  if (clientStateIsPrimary() || !scope) return
  const [folder, occurrence] = JSON.parse(scope) as [string, number]
  const values = read()
  // Compact the same bound inventory used when admitting a new occurrence.
  for (const [id, key] of [...scopes].sort((a, b) => JSON.parse(a[1])[1] - JSON.parse(b[1])[1])) {
    const [path, rank] = JSON.parse(key) as [string, number]
    if (path !== folder || rank <= occurrence) continue
    const next = JSON.stringify([path, rank - 1]), value = values[key]
    delete values[key]
    if (value) values[next] = value
    scopes.set(id, next)
  }
  try { window.localStorage.setItem(KEY, JSON.stringify(values)) } catch { /* Best-effort layout persistence. */ }
}

/** Native snapshots migrate by descriptor order; web clients adopt on explicit opening. */
export function adoptLocalLegacyPreview(instanceId: string, sessionId: string) {
  if (clientStateIsPrimary()) return
  const scope = scopes.get(instanceId)
  if (!scope) return
  const [folder] = JSON.parse(scope) as [string, number]
  const source = readClientLayoutValue(LEGACY_SESSION_PREVIEWS_KEY)
  const entries = parseLegacySessionPreviews(source)
  let exact: typeof entries[number] | undefined, fallback: typeof entries[number] | undefined
  for (const entry of entries) {
    const [key] = entry
    let path = key, session: string | undefined
    try {
      const tuple: unknown = JSON.parse(key)
      if (Array.isArray(tuple) && tuple.length === 2 && tuple.every(part => typeof part === "string")) [path, session] = tuple
    } catch { /* A project-wide record uses its folder directly. */ }
    if (normalizeWorkspacePath(path) !== folder) continue
    if (session === sessionId) exact = entry
    else if (session === undefined) fallback = entry
  }
  const adopted = exact ?? fallback
  if (!adopted) return
  const view: RestorableTabViewState = { version: 1, previews: { [sessionId]: adopted[1] } }
  return { view, source, remaining: JSON.stringify(Object.fromEntries(entries.filter(([key]) => key !== adopted[0]))) }
}

export function retireLocalLegacyPreview(value: { source: string | null; remaining: string }) {
  if (readClientLayoutValue(LEGACY_SESSION_PREVIEWS_KEY) === value.source)
    writeClientLayoutValue(LEGACY_SESSION_PREVIEWS_KEY, value.remaining)
}
