import { getLogger } from "../lib/logger"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { normalizeRestorableAttachmentRecord } from "./client-state-attachments-codec"
import { getAuthoritativeAttachmentSessionIdsForInstance, getSessionAttachmentsForInstance } from "./attachments"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import { currentDraftAbsences, hydrateWorkspacePromptState, recoverDeletedWorkspacePrompts } from "./app-session-prompt-hydration"
import { getRestoredSessionIds } from "./app-session-restored-session-ids"
import { NO_SESSION_DRAFT_SESSION_ID } from "./local-draft-ids"
import { hydrateRestoredSessionChain } from "./session-api"
import { getAuthoritativeDraftSessionIdsForInstance, getSessionDraftPromptsForInstance, getSessions, isSessionInWorkspaceScope } from "./session-state"
import { waitForInstanceInitialSessionHydration } from "./instances"

/**
 * Unsent drafts and attachments of project tabs removed from this window,
 * kept for the page lifetime so reopening the project gives them back.
 */
type ClosedWorkspaceDrafts = Pick<RestorableWorkspaceTabState, "drafts" | "attachments">
type DraftSnapshot = ClosedWorkspaceDrafts & Pick<RestorableWorkspaceTabState, "folder" | "workspaceId">
type VaultEntry = ClosedWorkspaceDrafts & { origins: Record<string, readonly string[]> }

export const MAX_CLOSED_WORKSPACE_DRAFTS = 16

const log = getLogger("session")
const vault = new Map<string, VaultEntry>()
// Folder fallback carries bytes; only a saved workspace identity can carry clears.
const closedAuthority = new Map<string, Map<string, Set<string>>>()
const restoreAuthority = new Map<string, {
  key: string
  snapshotId?: string
  claimedIds: Set<string>
  clearSource?: { id: string; sessions: Set<string> }
  entry?: VaultEntry
}>()
/**
 * Entries taken by a reopened instance whose restore has not finished. They are
 * the only older drafts that can come back to the vault, so a later close
 * supersedes its sessions in them directly.
 */
const claims = new Map<string, { key: string; entry: VaultEntry }>()

/** Project identity: the backend (one per window today) and the normalized folder. */
export function closedWorkspaceDraftKey(folder: string, backendId = ""): string {
  return `${backendId}\n${normalizeWorkspacePath(folder)}`
}

/** Snapshot fallback yields per session, including both fields of a clear. */
const noSnapshotAuthority: ReadonlySet<string> = new Set()

export function closedDraftSnapshotAuthority(instanceId: string): ReadonlySet<string> {
  const bound = restoreAuthority.get(instanceId)
  if (!bound) return noSnapshotAuthority
  return bound.clearSource ? new Set([...bound.claimedIds, ...bound.clearSource.sessions]) : bound.claimedIds
}

export function omitSupersededClosedDrafts<T extends DraftSnapshot>(
  instanceId: string,
  snapshot: T,
): T {
  void restoreClosedWorkspaceDrafts(instanceId, snapshot.folder, () => waitForInstanceInitialSessionHydration(instanceId), snapshot)
  const key = closedWorkspaceDraftKey(snapshot.folder)
  const sourceId = snapshot.workspaceId
  const existing = restoreAuthority.get(instanceId)
  const sources = closedAuthority.get(key)
  const marks = sourceId && sources?.get(sourceId)
  if (sourceId && marks && sources && (!existing || (existing.key === key && (!existing.clearSource || existing.clearSource.id === sourceId)))) {
    const bound = existing ?? { key, claimedIds: new Set<string>() }
    bound.clearSource = { id: sourceId, sessions: new Set([...(bound.clearSource?.sessions ?? []), ...marks]) }
    restoreAuthority.set(instanceId, bound)
    sources.delete(sourceId)
    if (!sources.size) closedAuthority.delete(key)
  }
  const bound = restoreAuthority.get(instanceId)
  const superseded = bound?.key !== key ? noSnapshotAuthority
    : bound.clearSource?.id === sourceId ? closedDraftSnapshotAuthority(instanceId) : bound.claimedIds
  return superseded.size ? { ...snapshot, ...pick(snapshot, id => !superseded.has(id)) } : snapshot
}

export function pendingClosedDrafts(instanceId: string): ClosedWorkspaceDrafts {
  const entry = restoreAuthority.get(instanceId)?.entry
  return entry ? emptySessionsOf(instanceId, entry) : empty
}

const contentSessions = (entry: ClosedWorkspaceDrafts) =>
  new Set([...Object.keys(entry.drafts), ...Object.keys(entry.attachments)])

function pick<T extends ClosedWorkspaceDrafts>(entry: T, keep: (sessionId: string) => boolean): T {
  const filter = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([sessionId]) => keep(sessionId)))
  return {
    ...entry, drafts: filter(entry.drafts), attachments: filter(entry.attachments),
    ...("origins" in entry ? { origins: filter((entry as VaultEntry).origins) } : {}),
  }
}

/** `top` wins for its sessions and `replaced`: their text and attachments move together. */
function merge(base: VaultEntry, top: VaultEntry, replaced: ReadonlySet<string>): VaultEntry {
  const topIds = contentSessions(top)
  const kept = pick(base, (sessionId) => !replaced.has(sessionId) && !topIds.has(sessionId))
  return { drafts: { ...kept.drafts, ...top.drafts }, attachments: { ...kept.attachments, ...top.attachments },
    origins: { ...kept.origins, ...top.origins } }
}

function stash(key: string, merged: VaultEntry): void {
  vault.delete(key)
  if (contentSessions(merged).size === 0) return
  vault.set(key, merged)
  while (vault.size > MAX_CLOSED_WORKSPACE_DRAFTS) vault.delete(vault.keys().next().value!)
}

const empty: VaultEntry = { drafts: {}, attachments: {}, origins: {} }

/** Sessions the user typed in, cleared or sent from in this instance. */
const touchedSessions = (instanceId: string) => new Set([
  ...getAuthoritativeDraftSessionIdsForInstance(instanceId),
  ...getAuthoritativeAttachmentSessionIdsForInstance(instanceId),
])

function captureInstanceDrafts(instanceId: string, snapshotId?: string): VaultEntry {
  const drafts = getSessionDraftPromptsForInstance(instanceId)
  const entry = normalizeRestorableAttachmentRecord(getSessionAttachmentsForInstance(instanceId), drafts)
    ?? { drafts, attachments: {} }
  const origins = snapshotId && snapshotId !== instanceId ? [instanceId, snapshotId] : [instanceId]
  return { ...entry, origins: Object.fromEntries([...contentSessions(entry)].map(id => [id, origins])) }
}

/** Sessions of `entry` this instance shows nothing for and the user has not touched. */
function emptySessionsOf(instanceId: string, entry: VaultEntry): VaultEntry {
  const drafts = getSessionDraftPromptsForInstance(instanceId)
  const attachments = getSessionAttachmentsForInstance(instanceId)
  const touched = touchedSessions(instanceId)
  return pick(entry, (sessionId) => !drafts[sessionId] && !attachments[sessionId]?.length && !touched.has(sessionId))
}

/** Returns what a restore could not apply underneath the project's newer drafts. */
function requeue(key: string, older: VaultEntry): void {
  stash(key, merge(older, vault.get(key) ?? empty, new Set()))
}

/**
 * Called while an instance is removed, before its drafts are cleared. `keep`
 * hands its drafts over: the later close wins per session, clears and sends
 * included, over the vault and over every pending restore of the project, and
 * whatever an unfinished restore into it had not applied goes back underneath.
 * `skip` keeps nothing of this instance; `discard` also purges the project's
 * whole entry, because its folder is deleted.
 */
export function retainClosedWorkspaceDrafts(
  instanceId: string,
  folder: string,
  mode: "keep" | "skip" | "discard" = "keep",
): void {
  const key = closedWorkspaceDraftKey(folder)
  const claim = claims.get(instanceId)
  const bound = restoreAuthority.get(instanceId)
  claims.delete(instanceId)
  restoreAuthority.delete(instanceId)
  if (mode !== "keep") {
    if (mode === "discard") {
      vault.delete(key)
      closedAuthority.delete(key)
    }
    return
  }
  const remaining = claim ? emptySessionsOf(instanceId, claim.entry) : null
  const snapshotId = bound?.key === key ? bound.snapshotId : undefined
  const captured = captureInstanceDrafts(instanceId, snapshotId)
  // Sessions emptied by typing, clearing or sending supersede older drafts too.
  const superseded = new Set([...contentSessions(captured), ...touchedSessions(instanceId)])
  const written = contentSessions(captured)
  const inherited = bound?.key === key ? bound.clearSource : undefined
  const cleared = [...new Set([...superseded, ...(inherited?.sessions ?? [])])].filter(id => !written.has(id))
  if (cleared.length || closedAuthority.has(key)) {
    const authority = closedAuthority.get(key) ?? new Map<string, Set<string>>()
    for (const source of new Set([instanceId, ...(snapshotId ? [snapshotId] : [])])) {
      const marks = new Set([...(authority.get(source) ?? []), ...cleared])
      for (const id of written) marks.delete(id)
      if (marks.size) authority.set(source, marks)
      else authority.delete(source)
    }
    closedAuthority.delete(key)
    if (authority.size) closedAuthority.set(key, authority)
    while (closedAuthority.size > MAX_CLOSED_WORKSPACE_DRAFTS) closedAuthority.delete(closedAuthority.keys().next().value!)
  }
  // A sibling close supersedes pending vault bytes, not the sibling's independent snapshot.
  for (const bound of restoreAuthority.values()) {
    if (bound.key === key && bound.entry) bound.entry = pick(bound.entry, id => !superseded.has(id))
  }
  for (const pending of claims.values()) {
    if (pending.key === key) pending.entry = pick(pending.entry, (sessionId) => !superseded.has(sessionId))
  }
  stash(key, merge(vault.get(key) ?? empty, captured, superseded))
  if (remaining) requeue(key, remaining)
}

/**
 * Called once the opening's own saved prompts (or their absence) are known.
 * Hydrates through the restore rules
 * without replacing live prompts. Proven deletions transfer their saved
 * prompts; unavailable sessions keep their claim for the next opening.
 */
export function restoreClosedWorkspaceDrafts(
  instanceId: string,
  folder: string,
  sessionsReady: () => Promise<void>,
  snapshot?: DraftSnapshot,
): Promise<void> | undefined {
  const key = closedWorkspaceDraftKey(folder)
  if (restoreAuthority.has(instanceId)) return
  const available = vault.get(key)
  const occupied = snapshot ? contentSessions(snapshot) : noSnapshotAuthority
  const snapshotId = snapshot?.workspaceId
  const cleared = snapshotId ? closedAuthority.get(key)?.get(snapshotId) : undefined
  const matchesOrigin = (id: string) => Boolean(snapshotId && available?.origins[id]?.includes(snapshotId))
  const entry = available && emptySessionsOf(instanceId, pick(available, id =>
    !cleared?.has(id) && (!occupied.has(id) || matchesOrigin(id))))
  const claimed = entry ? contentSessions(entry) : new Set<string>()
  const bound = { key, snapshotId, claimedIds: new Set([...claimed].filter(matchesOrigin)), entry }
  restoreAuthority.set(instanceId, bound)
  if (!available || !entry || !claimed.size) return
  stash(key, pick(available, id => !claimed.has(id)))
  // A retry moves the unresolved source to its new claimant; only that binding captures it.
  for (const other of restoreAuthority.values()) {
    if (other !== bound && other.key === key && other.entry) other.entry = pick(other.entry, id => !claimed.has(id))
  }
  const claim = { key, entry }
  claims.set(instanceId, claim)
  const isCurrent = () => claims.get(instanceId) === claim
  const finish = () => {
    claims.delete(instanceId)
    bound.entry = emptySessionsOf(instanceId, claim.entry)
    // Once returned to the vault, only actual pending bytes are eligible for a new claim.
    requeue(key, bound.entry)
  }
  // Reads `claim.entry`: closes of sibling tabs may supersede sessions meanwhile.
  const hydrate = () => hydrateWorkspacePromptState(
    instanceId,
    emptySessionsOf(instanceId, claim.entry),
    new Set(getSessions(instanceId).filter(session => !session.catalogSnapshot && isSessionInWorkspaceScope(instanceId, session.id)).map(({ id }) => id)),
    NO_SESSION_DRAFT_SESSION_ID,
  )
  hydrate()
  return (async () => {
    await sessionsReady()
    if (!isCurrent()) return
    const absenceProofs = await hydrateRestoredSessionChain(instanceId, getRestoredSessionIds([
      Object.keys(claim.entry.drafts), Object.keys(claim.entry.attachments),
    ]), undefined, isCurrent, true)
    if (!isCurrent()) return
    hydrate()
    recoverDeletedWorkspacePrompts(instanceId, emptySessionsOf(instanceId, claim.entry), currentDraftAbsences(absenceProofs))
    recoverDeletedWorkspacePrompts(instanceId, emptySessionsOf(instanceId, claim.entry))
    finish()
  })().catch((error) => {
    if (!isCurrent()) return
    log.warn("Failed to restore drafts of a closed project", { instanceId, error })
    hydrate()
    recoverDeletedWorkspacePrompts(instanceId, emptySessionsOf(instanceId, claim.entry))
    finish()
  })
}

/** Test-only reset. */
export function clearClosedWorkspaceDrafts(): void {
  vault.clear()
  claims.clear()
  closedAuthority.clear()
  restoreAuthority.clear()
}
