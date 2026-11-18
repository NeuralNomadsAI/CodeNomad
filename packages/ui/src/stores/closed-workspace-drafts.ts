import { getLogger } from "../lib/logger"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { normalizeRestorableAttachmentRecord } from "./client-state-attachments-codec"
import { getAuthoritativeAttachmentSessionIdsForInstance, getSessionAttachmentsForInstance } from "./attachments"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import { currentDraftAbsences, hydrateWorkspacePromptState, recoverDeletedWorkspacePrompts } from "./app-session-prompt-hydration"
import { getRestoredSessionIds } from "./app-session-restored-session-ids"
import { NO_SESSION_DRAFT_SESSION_ID } from "./app-session-workspace-hydration"
import { hydrateRestoredSessionChain } from "./session-api"
import { getAuthoritativeDraftSessionIdsForInstance, getSessionDraftPromptsForInstance, getSessions, isSessionInWorkspaceScope } from "./session-state"

/**
 * Unsent drafts and attachments of project tabs removed from this window,
 * kept for the page lifetime so reopening the project gives them back.
 */
type ClosedWorkspaceDrafts = Pick<RestorableWorkspaceTabState, "drafts" | "attachments">

export const MAX_CLOSED_WORKSPACE_DRAFTS = 16

const log = getLogger("session")
const vault = new Map<string, ClosedWorkspaceDrafts>()
// A close with no remaining content still supersedes older snapshots.
const closedAuthority = new Map<string, Set<string>>()
const restoreAuthority = new Map<string, { key: string; superseded: Set<string>; entry?: ClosedWorkspaceDrafts }>()
/**
 * Entries taken by a reopened instance whose restore has not finished. They are
 * the only older drafts that can come back to the vault, so a later close
 * supersedes its sessions in them directly.
 */
const claims = new Map<string, { key: string; entry: ClosedWorkspaceDrafts }>()

/** Project identity: the backend (one per window today) and the normalized folder. */
export function closedWorkspaceDraftKey(folder: string, backendId = ""): string {
  return `${backendId}\n${normalizeWorkspacePath(folder)}`
}

/** Snapshot fallback yields per session, including both fields of a clear. */
export function closedDraftSnapshotAuthority(instanceId: string, folder?: string): ReadonlySet<string> {
  const bound = restoreAuthority.get(instanceId)
  return bound?.superseded ?? (folder === undefined ? undefined : closedAuthority.get(closedWorkspaceDraftKey(folder))) ?? new Set()
}

export function omitSupersededClosedDrafts<T extends ClosedWorkspaceDrafts>(instanceId: string, snapshot: T, folder?: string): T {
  const superseded = closedDraftSnapshotAuthority(instanceId, folder)
  return superseded.size ? { ...snapshot, ...pick(snapshot, id => !superseded.has(id)) } : snapshot
}

export function pendingClosedDrafts(instanceId: string): ClosedWorkspaceDrafts {
  const entry = restoreAuthority.get(instanceId)?.entry
  return entry ? emptySessionsOf(instanceId, entry) : empty
}

const contentSessions = (entry: ClosedWorkspaceDrafts) =>
  new Set([...Object.keys(entry.drafts), ...Object.keys(entry.attachments)])

function pick(entry: ClosedWorkspaceDrafts, keep: (sessionId: string) => boolean): ClosedWorkspaceDrafts {
  const filter = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([sessionId]) => keep(sessionId)))
  return { drafts: filter(entry.drafts), attachments: filter(entry.attachments) }
}

/** `top` wins for its sessions and `replaced`: their text and attachments move together. */
function merge(base: ClosedWorkspaceDrafts, top: ClosedWorkspaceDrafts, replaced: ReadonlySet<string>): ClosedWorkspaceDrafts {
  const kept = pick(base, (sessionId) => !replaced.has(sessionId) && !contentSessions(top).has(sessionId))
  return { drafts: { ...kept.drafts, ...top.drafts }, attachments: { ...kept.attachments, ...top.attachments } }
}

function stash(key: string, merged: ClosedWorkspaceDrafts): void {
  vault.delete(key)
  if (contentSessions(merged).size === 0) return
  vault.set(key, merged)
  while (vault.size > MAX_CLOSED_WORKSPACE_DRAFTS) vault.delete(vault.keys().next().value!)
}

const empty: ClosedWorkspaceDrafts = { drafts: {}, attachments: {} }

/** Sessions the user typed in, cleared or sent from in this instance. */
const touchedSessions = (instanceId: string) => new Set([
  ...getAuthoritativeDraftSessionIdsForInstance(instanceId),
  ...getAuthoritativeAttachmentSessionIdsForInstance(instanceId),
])

function captureInstanceDrafts(instanceId: string): ClosedWorkspaceDrafts {
  const drafts = getSessionDraftPromptsForInstance(instanceId)
  return normalizeRestorableAttachmentRecord(getSessionAttachmentsForInstance(instanceId), drafts)
    ?? { drafts, attachments: {} }
}

/** Sessions of `entry` this instance shows nothing for and the user has not touched. */
function emptySessionsOf(instanceId: string, entry: ClosedWorkspaceDrafts): ClosedWorkspaceDrafts {
  const drafts = getSessionDraftPromptsForInstance(instanceId)
  const attachments = getSessionAttachmentsForInstance(instanceId)
  const touched = touchedSessions(instanceId)
  return pick(entry, (sessionId) => !drafts[sessionId] && !attachments[sessionId]?.length && !touched.has(sessionId))
}

/** Returns what a restore could not apply underneath the project's newer drafts. */
function requeue(key: string, older: ClosedWorkspaceDrafts): void {
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
  const captured = captureInstanceDrafts(instanceId)
  // Sessions emptied by typing, clearing or sending supersede older drafts too.
  const superseded = new Set([...contentSessions(captured), ...touchedSessions(instanceId)])
  if (superseded.size) {
    const authority = new Set([...(closedAuthority.get(key) ?? []), ...superseded])
    closedAuthority.delete(key)
    closedAuthority.set(key, authority)
    while (closedAuthority.size > MAX_CLOSED_WORKSPACE_DRAFTS) closedAuthority.delete(closedAuthority.keys().next().value!)
    // A sibling close can supersede a pending restoration of an older source.
    for (const bound of restoreAuthority.values()) {
      if (bound.key === key) {
        for (const id of superseded) bound.superseded.add(id)
        if (bound.entry) bound.entry = pick(bound.entry, id => !superseded.has(id))
      }
    }
  }
  for (const pending of claims.values()) {
    if (pending.key === key) pending.entry = pick(pending.entry, (sessionId) => !superseded.has(sessionId))
  }
  stash(key, merge(vault.get(key) ?? empty, captured, superseded))
  if (remaining) requeue(key, remaining)
}

/**
 * Called once when an instance is added. Hydrates through the restore rules
 * without replacing live prompts. Proven deletions transfer their saved
 * prompts; unavailable sessions keep their claim for the next opening.
 */
export function restoreClosedWorkspaceDrafts(
  instanceId: string,
  folder: string,
  sessionsReady: () => Promise<void>,
): Promise<void> | undefined {
  const key = closedWorkspaceDraftKey(folder)
  const entry = vault.get(key)
  const bound = { key, superseded: new Set([...(closedAuthority.get(key) ?? []), ...(entry ? contentSessions(entry) : [])]), entry }
  restoreAuthority.set(instanceId, bound)
  if (!entry) return
  vault.delete(key)
  // A retry moves the unresolved source to its new claimant; only that binding captures it.
  for (const other of restoreAuthority.values()) {
    if (other !== bound && other.key === key && other.entry) other.entry = pick(other.entry, id => !bound.superseded.has(id))
  }
  const claim = { key, entry }
  claims.set(instanceId, claim)
  const isCurrent = () => claims.get(instanceId) === claim
  const finish = () => {
    claims.delete(instanceId)
    bound.entry = emptySessionsOf(instanceId, claim.entry)
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
