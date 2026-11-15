import { getLogger } from "../lib/logger"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { normalizeRestorableAttachmentRecord } from "./client-state-attachments-codec"
import { getAuthoritativeAttachmentSessionIdsForInstance, getSessionAttachmentsForInstance } from "./attachments"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import { hydrateWorkspacePromptState } from "./app-session-prompt-hydration"
import { getRestoredSessionIds } from "./app-session-restored-session-ids"
import { NO_SESSION_DRAFT_SESSION_ID } from "./app-session-workspace-hydration"
import { hydrateRestoredSessionChain } from "./session-api"
import { getAuthoritativeDraftSessionIdsForInstance, getSessionDraftPromptsForInstance, getSessions } from "./session-state"

/**
 * Unsent drafts and attachments of project tabs removed from this window,
 * kept for the page lifetime so reopening the project gives them back.
 * `cleared` lists sessions a later-closed tab emptied by typing, clearing or
 * sending: they supersede older drafts of the same project.
 */
type ClosedWorkspaceDrafts = Pick<RestorableWorkspaceTabState, "drafts" | "attachments"> & { cleared: string[] }

export const MAX_CLOSED_WORKSPACE_DRAFTS = 16

const log = getLogger("session")
const vault = new Map<string, ClosedWorkspaceDrafts>()
const claims = new Map<string, { key: string; entry: ClosedWorkspaceDrafts }>()

/** Project identity: the backend (one per window today) and the normalized folder. */
export function closedWorkspaceDraftKey(folder: string, backendId = ""): string {
  return `${backendId}\n${normalizeWorkspacePath(folder)}`
}

const contentSessions = (entry: Pick<ClosedWorkspaceDrafts, "drafts" | "attachments">) =>
  new Set([...Object.keys(entry.drafts), ...Object.keys(entry.attachments)])

function pick(entry: ClosedWorkspaceDrafts, keep: (sessionId: string) => boolean): ClosedWorkspaceDrafts {
  const filter = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([sessionId]) => keep(sessionId)))
  return { drafts: filter(entry.drafts), attachments: filter(entry.attachments), cleared: entry.cleared.filter(keep) }
}

/** A session present in `top`, cleared included, replaces that session's text and attachments in `base`. */
function merge(base: ClosedWorkspaceDrafts, top: ClosedWorkspaceDrafts): ClosedWorkspaceDrafts {
  const replaced = new Set([...contentSessions(top), ...top.cleared])
  const kept = pick(base, (sessionId) => !replaced.has(sessionId))
  return {
    drafts: { ...kept.drafts, ...top.drafts },
    attachments: { ...kept.attachments, ...top.attachments },
    cleared: [...kept.cleared, ...top.cleared],
  }
}

const isClaimed = (key: string) => [...claims.values()].some((claim) => claim.key === key)

function stash(key: string, entry: ClosedWorkspaceDrafts, position: "newer" | "older"): void {
  const existing = vault.get(key)
  const merged = !existing ? entry : position === "newer" ? merge(existing, entry) : merge(entry, existing)
  vault.delete(key)
  // Clear marks only matter against older drafts: a pending restore may still give some back.
  if (contentSessions(merged).size === 0 && (merged.cleared.length === 0 || !isClaimed(key))) return
  vault.set(key, merged)
  while (vault.size > MAX_CLOSED_WORKSPACE_DRAFTS) vault.delete(vault.keys().next().value!)
}

/** Sessions the user typed in, cleared or sent from in this instance. */
const touchedSessions = (instanceId: string) => new Set([
  ...getAuthoritativeDraftSessionIdsForInstance(instanceId),
  ...getAuthoritativeAttachmentSessionIdsForInstance(instanceId),
])

function captureInstanceDrafts(instanceId: string): ClosedWorkspaceDrafts {
  const drafts = getSessionDraftPromptsForInstance(instanceId)
  const normalized = normalizeRestorableAttachmentRecord(getSessionAttachmentsForInstance(instanceId), drafts)
    ?? { drafts, attachments: {} }
  const content = contentSessions(normalized)
  return { ...normalized, cleared: [...touchedSessions(instanceId)].filter((sessionId) => !content.has(sessionId)) }
}

/** Sessions of `entry` this instance shows nothing for and the user has not touched. */
function emptySessionsOf(instanceId: string, entry: ClosedWorkspaceDrafts): ClosedWorkspaceDrafts {
  const drafts = getSessionDraftPromptsForInstance(instanceId)
  const attachments = getSessionAttachmentsForInstance(instanceId)
  const touched = touchedSessions(instanceId)
  return pick(entry, (sessionId) => !drafts[sessionId] && !attachments[sessionId]?.length && !touched.has(sessionId))
}

/**
 * Called while an instance is removed, before its drafts are cleared. The
 * later close wins per session, clears and sends included. Whatever an
 * unfinished restore into the removed instance had not applied goes back
 * underneath.
 */
export function retainClosedWorkspaceDrafts(instanceId: string, folder: string, keep = true): void {
  const claim = claims.get(instanceId)
  claims.delete(instanceId)
  if (!keep) return
  const remaining = claim ? emptySessionsOf(instanceId, claim.entry) : null
  stash(closedWorkspaceDraftKey(folder), captureInstanceDrafts(instanceId), "newer")
  if (claim && remaining) stash(claim.key, remaining, "older")
}

/**
 * Called once when an instance is added. Hydrates through the restore rules
 * (only existing sessions, fetched like restored ones, never over what the
 * user changed) and only into sessions the instance still shows nothing for,
 * so state another restore path hydrated stays. The new-conversation draft
 * applies immediately.
 */
export function restoreClosedWorkspaceDrafts(
  instanceId: string,
  folder: string,
  sessionsReady: () => Promise<void>,
): void {
  const key = closedWorkspaceDraftKey(folder)
  const entry = vault.get(key)
  if (!entry) return
  vault.delete(key)
  const claim = { key, entry }
  claims.set(instanceId, claim)
  const isCurrent = () => claims.get(instanceId) === claim
  const hydrate = () => hydrateWorkspacePromptState(
    instanceId,
    emptySessionsOf(instanceId, entry),
    new Set(getSessions(instanceId).map(({ id }) => id)),
    NO_SESSION_DRAFT_SESSION_ID,
  )
  hydrate()
  void (async () => {
    await sessionsReady()
    if (!isCurrent()) return
    await hydrateRestoredSessionChain(instanceId, getRestoredSessionIds([
      Object.keys(entry.drafts), Object.keys(entry.attachments),
    ]), undefined, isCurrent)
    if (!isCurrent()) return
    hydrate()
    claims.delete(instanceId)
  })().catch((error) => {
    if (!isCurrent()) return
    log.warn("Failed to restore drafts of a closed project", { instanceId, error })
    hydrate()
    claims.delete(instanceId)
    stash(key, emptySessionsOf(instanceId, entry), "older")
  })
}

/** Test-only reset. */
export function clearClosedWorkspaceDrafts(): void {
  vault.clear()
  claims.clear()
}
