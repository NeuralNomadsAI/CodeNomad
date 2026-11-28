import { normalizeServerSelection, sameServerSelection, type ServerSelectionIntent } from "../codenomad-servers/selection-policy"
import { normalizeWorkspacePath } from "../workspaces/workspace-path-key"
import { isPlainObject } from "./merge-patch"
import type { SettingsDoc } from "./yaml-doc-store"

export const RECENT_PROJECT_LIMIT = 20

export interface RemoteProjectRecentData {
  readonly policy: ServerSelectionIntent
  readonly path: string
  readonly lastAccessed: number
  readonly projectName?: string
}

export type RemoteProjectRecentEdit = Partial<RemoteProjectRecentData> & {
  openedName?: string
}

function policyKey(policy: ServerSelectionIntent): readonly [string, string, boolean, string | null] {
  return [policy.id, policy.baseUrl, policy.skipTlsVerify, policy.ssh?.host ?? null]
}

export function remoteProjectRecentKey({ policy, path }: Pick<RemoteProjectRecentData, "policy" | "path">): string {
  return JSON.stringify([...policyKey(policy), normalizeWorkspacePath(path)])
}

/** Persist edits at independent Merge Patch leaves. A rename never changes visibility. */
export function readRemoteProjectHistory(legacy: unknown, keyed: unknown, beforeMerge?: Record<string, unknown>) {
  const records = new Map(normalizeRemoteProjectRecents(legacy).map(item => [remoteProjectRecentKey(item), item]))
  const edits = new Map<string, RemoteProjectRecentEdit>()
  if (isPlainObject(keyed)) {
    for (const [key, value] of Object.entries(keyed)) {
      if (!isPlainObject(value)) continue
      const edit = value as RemoteProjectRecentEdit & { removed?: boolean }
      // Consume legacy removal markers while folding the old list into keyed history.
      if (edit.removed === true) {
        records.delete(key)
        continue
      }
      const record = normalizeRemoteProjectRecent({ ...records.get(key), ...edit })
      if (!record || remoteProjectRecentKey(record) !== key) continue
      const previous = beforeMerge?.[key]
      const previousAccess = isPlainObject(previous) ? previous.lastAccessed : undefined
      // Existing valid rows keep their newest access, regardless of patch arrival order.
      const lastAccessed = typeof previousAccess === "number" && Number.isFinite(previousAccess)
        ? Math.max(record.lastAccessed, previousAccess) : record.lastAccessed
      const projectName = record.projectName ?? recentProjectName(edit.openedName)
      records.set(key, { ...record, lastAccessed, ...(projectName ? { projectName } : {}) })
      edits.set(key, { projectName: record.projectName, openedName: edit.openedName })
    }
  }
  return { recents: [...records.values()].sort((a, b) => b.lastAccessed - a.lastAccessed), edits }
}

/** Compact after merging, in the same state transaction as a window's edit. */
export function compactRemoteProjectHistory(doc: SettingsDoc, beforeMerge?: SettingsDoc): SettingsDoc {
  if (!isPlainObject(doc.ui)) return doc
  const ui = doc.ui
  if (!("remoteProjectHistory" in ui || "remoteProjectRecents" in ui)) return doc
  const previous = isPlainObject(beforeMerge?.ui) ? beforeMerge.ui.remoteProjectHistory : undefined
  const { recents, edits } = readRemoteProjectHistory(
    ui.remoteProjectRecents, ui.remoteProjectHistory, isPlainObject(previous) ? previous : undefined,
  )
  const active = new Set<string>()
  if (Array.isArray(ui.remoteServers)) {
    for (const profile of ui.remoteServers) {
      if (!isPlainObject(profile) || typeof profile.name !== "string" || !profile.name.trim()) continue
      const policy = normalizeServerSelection({
        id: typeof profile.id === "string" ? profile.id.trim() : undefined,
        baseUrl: typeof profile.baseUrl === "string" ? profile.baseUrl.trim() : undefined,
        skipTlsVerify: Boolean(profile.skipTlsVerify),
        ssh: isPlainObject(profile.ssh) && typeof profile.ssh.host === "string" ? { host: profile.ssh.host.trim() } : profile.ssh,
      })
      if (policy) active.add(JSON.stringify(policyKey(policy)))
    }
  }
  const pinned = new Set<string>()
  const history: Record<string, RemoteProjectRecentEdit> = {}
  let recentCount = 0
  for (const { projectName, ...record } of recents) {
    const policy = JSON.stringify(policyKey(record.policy))
    if (!active.has(policy) || (recentCount >= RECENT_PROJECT_LIMIT && pinned.has(policy))) continue
    const key = remoteProjectRecentKey(record)
    const openedName = recentProjectName(edits.get(key)?.openedName)
    history[key] = { ...record, ...(projectName && (edits.get(key)?.projectName !== undefined || !openedName) ? { projectName } : {}),
      ...(openedName ? { openedName } : {}) }
    recentCount++
    pinned.add(policy)
  }
  const next: SettingsDoc = { ...ui, remoteProjectHistory: history }
  delete next.remoteProjectRecents
  return { ...doc, ui: next }
}

export function recentProjectName(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, 256) || undefined : undefined
}

export function normalizeRemoteProjectRecent(value: unknown): RemoteProjectRecentData | undefined {
  if (!value || typeof value !== "object") return
  const { policy: rawPolicy, path, lastAccessed, projectName: rawName } = value as Record<string, unknown>
  const policy = normalizeServerSelection(rawPolicy)
  if (!policy || typeof path !== "string" || !path.trim() || path.length > 4096 || path.includes("\0")
    || !normalizeWorkspacePath(path) || typeof lastAccessed !== "number" || !Number.isFinite(lastAccessed) || lastAccessed < 0) return
  const projectName = recentProjectName(rawName)
  return { policy, path, lastAccessed, ...(projectName ? { projectName } : {}) }
}

export function sameRemoteProjectRecent(
  a: Pick<RemoteProjectRecentData, "policy" | "path">,
  b: Pick<RemoteProjectRecentData, "policy" | "path">,
): boolean {
  return sameServerSelection(a.policy, b.policy) && normalizeWorkspacePath(a.path) === normalizeWorkspacePath(b.path)
}

/** Host UI state holds a bounded MRU of successful explicit remote opens. */
export function normalizeRemoteProjectRecents(value: unknown): RemoteProjectRecentData[] {
  const recents: RemoteProjectRecentData[] = []
  if (!Array.isArray(value)) return recents
  for (const item of value.slice(0, RECENT_PROJECT_LIMIT)) {
    const recent = normalizeRemoteProjectRecent(item)
    if (recent && !recents.some(previous => sameRemoteProjectRecent(previous, recent))) recents.push(recent)
  }
  return recents
}
