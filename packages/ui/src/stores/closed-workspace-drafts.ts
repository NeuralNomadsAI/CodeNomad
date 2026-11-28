import { getLogger } from "../lib/logger"
import { LOCAL_BACKEND_ID, parseInstanceKey } from "../lib/backend-identity"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { normalizeRestorableAttachmentRecord } from "./client-state-attachments-codec"
import { getAuthoritativeAttachmentSessionIdsForInstance, getSessionAttachmentsForInstance } from "./attachments"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import { currentDraftAbsences, hydrateWorkspacePromptState, recoverDeletedWorkspacePrompts } from "./app-session-prompt-hydration"
import { getRestoredSessionIds } from "./app-session-restored-session-ids"
import { NO_SESSION_DRAFT_SESSION_ID } from "./local-draft-ids"
import { hydrateRestoredSessionChain } from "./session-api"
import { getAuthoritativeDraftSessionIdsForInstance, getSessionDraftPromptsForInstance, getSessions, isSessionInWorkspaceScope } from "./session-state"
import { instances, waitForInstanceInitialSessionHydration } from "./instances"

/**
 * Unsent drafts and attachments of project tabs removed from this window,
 * kept for the page lifetime so reopening the project gives them back.
 */
type ClosedWorkspaceDrafts = Pick<RestorableWorkspaceTabState, "drafts" | "attachments">
type DraftSnapshot = ClosedWorkspaceDrafts & Pick<RestorableWorkspaceTabState, "folder" | "workspaceId" | "serverId">
type VaultEntry = ClosedWorkspaceDrafts & {
  origins: Record<string, readonly string[]>
  /** A received bundle may answer an unambiguous plain folder opening. */
  folderEligible?: Record<string, true>
}
type ProjectVault = { shared: VaultEntry; exact: Map<string, VaultEntry> }

export const MAX_CLOSED_WORKSPACE_DRAFTS = 16

const log = getLogger("session")
const vault = new Map<string, ProjectVault>()
// Folder fallback carries bytes; only a saved workspace identity can carry clears.
const closedAuthority = new Map<string, Map<string, Set<string>>>()
interface RestoreAuthority {
  key: string
  snapshotId?: string
  claimedIds: Set<string>
  returnOwners?: Map<string, string>
  receivedIds?: Set<string>
  clearSource?: { id: string; sessions: Set<string> }
  entry?: VaultEntry
}
const restoreAuthority = new Map<string, RestoreAuthority>()
/**
 * Entries taken by a reopened instance whose restore has not finished. They are
 * the only older drafts that can come back to the vault, so a later close
 * can invalidate folder fallback. Exact claims keep their occurrence authority.
 */
const claims = new Map<string, { key: string; entry: VaultEntry }>()

/** Closed occurrences merge within one backend's normalized project folder. */
export function closedWorkspaceDraftKey(folder: string, backendId = LOCAL_BACKEND_ID, serverId?: string): string {
  return JSON.stringify([backendId === LOCAL_BACKEND_ID ? "" : backendId, normalizeWorkspacePath(folder), serverId])
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
  const key = closedWorkspaceDraftKey(snapshot.folder, parseInstanceKey(instanceId).backendId,
    instances().get(instanceId)?.serverId ?? snapshot.serverId)
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
    ...("folderEligible" in entry ? { folderEligible: filter((entry as VaultEntry).folderEligible ?? {}) } : {}),
  }
}

/** `top` wins for its sessions and `replaced`: their text and attachments move together. */
function merge(base: VaultEntry, top: VaultEntry, replaced: ReadonlySet<string>): VaultEntry {
  const topIds = contentSessions(top)
  const kept = pick(base, (sessionId) => !replaced.has(sessionId) && !topIds.has(sessionId))
  return { drafts: { ...kept.drafts, ...top.drafts }, attachments: { ...kept.attachments, ...top.attachments },
    origins: { ...kept.origins, ...top.origins },
    folderEligible: { ...kept.folderEligible, ...top.folderEligible } }
}

function stash(key: string, project: ProjectVault): void {
  vault.delete(key)
  if (!contentSessions(project.shared).size && !project.exact.size) return
  vault.set(key, project)
  while (vault.size > MAX_CLOSED_WORKSPACE_DRAFTS) vault.delete(vault.keys().next().value!)
}

const empty: VaultEntry = { drafts: {}, attachments: {}, origins: {} }
const emptyProject = (): ProjectVault => ({ shared: empty, exact: new Map() })

function setExact(project: ProjectVault, owner: string, entry: VaultEntry) {
  project.exact.delete(owner)
  if (contentSessions(entry).size) project.exact.set(owner, entry)
  while (project.exact.size > MAX_CLOSED_WORKSPACE_DRAFTS) project.exact.delete(project.exact.keys().next().value!)
}

function pendingOwner(bound: RestoreAuthority | undefined, id: string): string | undefined {
  return bound?.returnOwners?.get(id) ?? (bound?.claimedIds.has(id) ? bound.snapshotId : undefined)
}

/** Closing a suspended remote tab hands its saved prompt state back to the vault. */
export function retainClosedWorkspaceSnapshot(snapshot: RestorableWorkspaceTabState): void {
  const key = closedWorkspaceDraftKey(snapshot.folder, snapshot.backendId, snapshot.serverId)
  const captured = normalizeRestorableAttachmentRecord(snapshot.attachments, snapshot.drafts)
    ?? { drafts: snapshot.drafts, attachments: {} }
  const ids = contentSessions(captured)
  const owner = snapshot.workspaceId
  const entry: VaultEntry = { ...captured,
    origins: owner ? Object.fromEntries([...ids].map(id => [id, [owner]])) : {},
    folderEligible: Object.fromEntries([...ids].map(id => [id, true])),
  }
  const project = vault.get(key) ?? emptyProject()
  supersedePendingDrafts(key, ids, (_id, pending) => pending === owner)
  if (owner) setExact(project, owner, merge(project.exact.get(owner) ?? empty, entry, ids))
  else project.shared = merge(project.shared, entry, ids)
  stash(key, project)
}

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

/** A return uses the same ownership as the claim, beneath newer writes of that owner. */
function requeue(bound: RestoreAuthority, older: VaultEntry): void {
  const project = vault.get(bound.key) ?? emptyProject()
  const shared = pick(older, id => !pendingOwner(bound, id))
  project.shared = merge(shared, project.shared, noSnapshotAuthority)
  const owners = new Set([...contentSessions(older)].map(id => pendingOwner(bound, id)))
  for (const owner of owners) if (owner) {
    const exact = pick(older, id => pendingOwner(bound, id) === owner)
    setExact(project, owner, merge(exact, project.exact.get(owner) ?? empty, noSnapshotAuthority))
  }
  stash(bound.key, project)
}

/** Keep capture and the native continuation on the same surviving bundles. */
function supersedePendingDrafts(
  key: string,
  ids: ReadonlySet<string>,
  supersedes: (id: string, owner: string | undefined, origins: readonly string[]) => boolean,
  except?: string,
) {
  for (const [instanceId, bound] of restoreAuthority) {
    if (instanceId === except || bound.key !== key) continue
    const keep = (entry: VaultEntry) => pick(entry, id => !ids.has(id) || !supersedes(id,
      pendingOwner(bound, id), entry.origins[id] ?? []))
    if (bound.entry) bound.entry = keep(bound.entry)
    const claim = claims.get(instanceId)
    if (claim) claim.entry = keep(claim.entry)
  }
}

/**
 * Called before the instance's drafts are cleared. `keep` saves its latest
 * bundles and clears, separately for its exact claims and folder fallback,
 * then returns untouched pending bundles beneath newer writes of their owner.
 * `suspend` leaves captured state with the placeholder and returns unapplied claims.
 * `skip` keeps nothing of this instance; `discard` purges the folder's entry.
 */
export function retainClosedWorkspaceDrafts(
  instanceId: string,
  folder: string,
  mode: "keep" | "skip" | "discard" | "suspend" = "keep",
  serverId = instances().get(instanceId)?.serverId,
): void {
  const key = closedWorkspaceDraftKey(folder, parseInstanceKey(instanceId).backendId, serverId)
  const claim = claims.get(instanceId)
  const bound = restoreAuthority.get(instanceId)
  claims.delete(instanceId)
  restoreAuthority.delete(instanceId)
  if (mode !== "keep") {
    if (mode === "discard") {
      vault.delete(key)
      closedAuthority.delete(key)
    }
    if (mode === "suspend" && claim && bound) requeue(bound, emptySessionsOf(instanceId, claim.entry))
    return
  }
  const remaining = claim ? emptySessionsOf(instanceId, claim.entry) : null
  const snapshotId = bound?.key === key ? bound.snapshotId : undefined
  const captured = captureInstanceDrafts(instanceId)
  // Sessions emptied by typing, clearing or sending supersede older drafts too.
  const touched = touchedSessions(instanceId)
  const superseded = new Set([...contentSessions(captured), ...touched])
  const written = contentSessions(captured)
  // Only delivered bundles (or newer local edits) leave the original lineage.
  const succeeded = new Set(bound?.receivedIds ?? [])
  for (const id of written) if (pendingOwner(bound, id)) succeeded.add(id)
  const inherited = bound?.key === key ? bound.clearSource : undefined
  const cleared = [...new Set([...superseded, ...(inherited?.sessions ?? [])])].filter(id => !written.has(id))
  const predecessors = new Map<string, Set<string>>()
  for (const id of new Set([...succeeded, ...touched])) {
    const owner = pendingOwner(bound, id)
    if (!owner || owner === instanceId) continue
    const ids = predecessors.get(owner) ?? new Set<string>()
    ids.add(id)
    predecessors.set(owner, ids)
  }
  if (cleared.length || predecessors.size || closedAuthority.has(key)) {
    const authority = closedAuthority.get(key) ?? new Map<string, Set<string>>()
    for (const source of new Set([instanceId, ...(snapshotId ? [snapshotId] : [])])) {
      const marks = new Set([...(authority.get(source) ?? []), ...cleared])
      for (const id of written) marks.delete(id)
      if (marks.size) authority.set(source, marks)
      else authority.delete(source)
    }
    for (const [owner, ids] of predecessors) authority.set(owner, new Set([...(authority.get(owner) ?? []), ...ids]))
    closedAuthority.delete(key)
    if (authority.size) closedAuthority.set(key, authority)
    while (closedAuthority.size > MAX_CLOSED_WORKSPACE_DRAFTS) closedAuthority.delete(closedAuthority.keys().next().value!)
  }
  const project = vault.get(key) ?? emptyProject()
  const owners = new Set([instanceId, ...(snapshotId ? [snapshotId] : [])])
  for (const owner of predecessors.keys()) owners.add(owner)
  const exactOwners = new Map<string, string>()
  for (const owner of owners) {
    const entry = project.exact.get(owner)
    if (entry) for (const id of contentSessions(entry)) exactOwners.set(id, owner)
  }
  for (const id of superseded) {
    const owner = pendingOwner(bound, id)
    if (owner) exactOwners.set(id, owner)
  }
  for (const id of succeeded) exactOwners.set(id, instanceId)
  const supersedes = (id: string, owner: string | undefined, origins: readonly string[]) =>
    owner !== undefined ? owner === instanceId || owner === snapshotId || predecessors.get(owner)?.has(id) === true
      : !exactOwners.has(id) || origins.some(origin => origin === instanceId || origin === snapshotId || predecessors.get(origin)?.has(id))
  supersedePendingDrafts(key, superseded, supersedes)
  // Apply the same owner check to parked bytes as to pending reads.
  const sharedSuperseded = new Set([...superseded].filter(id => supersedes(id, undefined, project.shared.origins[id] ?? [])))
  project.shared = merge(project.shared, pick(captured, id => !exactOwners.has(id)), sharedSuperseded)
  for (const owner of owners) {
    const existing = project.exact.get(owner)
    const replacements = pick(captured, id => exactOwners.get(id) === owner)
    if (owner === instanceId) {
      replacements.folderEligible = Object.fromEntries([...contentSessions(replacements)]
        .filter(id => succeeded.has(id)).map(id => [id, true]))
    }
    if (existing || contentSessions(replacements).size) {
      setExact(project, owner, merge(existing ?? empty, replacements,
        owner === instanceId || owner === snapshotId ? superseded : predecessors.get(owner) ?? noSnapshotAuthority))
    }
  }
  stash(key, project)
  if (remaining && bound) requeue(bound, remaining)
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
  const key = closedWorkspaceDraftKey(folder, parseInstanceKey(instanceId).backendId,
    instances().get(instanceId)?.serverId ?? snapshot?.serverId)
  if (restoreAuthority.has(instanceId)) return
  const project = vault.get(key)
  const available = project?.shared
  const occupied = snapshot ? contentSessions(snapshot) : noSnapshotAuthority
  const snapshotId = snapshot?.workspaceId
  const cleared = snapshotId ? closedAuthority.get(key)?.get(snapshotId) : undefined
  const matchesOrigin = (id: string) => Boolean(snapshotId && available?.origins[id]?.includes(snapshotId))
  const exact = snapshotId ? project?.exact.get(snapshotId) : undefined
  const exactIds = exact ? contentSessions(exact) : noSnapshotAuthority
  const eligible = (id: string) => !cleared?.has(id)
  const shared = available ? emptySessionsOf(instanceId, pick(available, id =>
    eligible(id) && !exactIds.has(id) && (!occupied.has(id) || matchesOrigin(id)))) : empty
  const owned = exact ? emptySessionsOf(instanceId, pick(exact, eligible)) : empty
  const sharedIds = contentSessions(shared)
  const ownedIds = contentSessions(owned)
  // Plain reopening can take a received successor only when there is no
  // competing shared bundle or another eligible successor for that session.
  const candidates = new Map<string, string | null>()
  if (!snapshot && project) for (const [owner, parked] of project.exact) {
    for (const id of contentSessions(parked)) {
      if (available?.origins[id]) continue
      candidates.set(id, candidates.has(id) || !parked.folderEligible?.[id] ? null : owner)
    }
  }
  let successor = empty
  const transfers = new Map<string, Set<string>>()
  if (project) for (const [id, owner] of candidates) {
    if (!owner) continue
    const bundle = emptySessionsOf(instanceId, pick(project.exact.get(owner)!, key => key === id))
    if (!contentSessions(bundle).size) continue
    successor = merge(successor, bundle, noSnapshotAuthority)
    const ids = transfers.get(owner) ?? new Set<string>()
    ids.add(id)
    transfers.set(owner, ids)
  }
  const entry = merge(merge(shared, owned, noSnapshotAuthority), successor, noSnapshotAuthority)
  const claimed = contentSessions(entry)
  const returnOwners = new Map<string, string>()
  for (const [owner, ids] of transfers) for (const id of ids) returnOwners.set(id, owner)
  const bound: RestoreAuthority = { key, snapshotId, claimedIds: new Set([...ownedIds, ...[...sharedIds].filter(matchesOrigin)]), returnOwners, entry }
  restoreAuthority.set(instanceId, bound)
  if (!project || !claimed.size) return
  project.shared = pick(project.shared, id => !sharedIds.has(id))
  if (snapshotId && exact) setExact(project, snapshotId, pick(exact, id => !ownedIds.has(id)))
  for (const [owner, ids] of transfers) setExact(project, owner, pick(project.exact.get(owner)!, id => !ids.has(id)))
  stash(key, project)
  // A retry moves unresolved bundles to the new claimant without taking another occurrence's exact claim.
  supersedePendingDrafts(key, claimed, (id, owner, origins) =>
    owner !== undefined ? owner === pendingOwner(bound, id)
      : sharedIds.has(id) && origins.some(origin => shared.origins[id]?.includes(origin)), instanceId)
  const claim = { key, entry }
  claims.set(instanceId, claim)
  const isCurrent = () => claims.get(instanceId) === claim
  const finish = () => {
    claims.delete(instanceId)
    bound.entry = emptySessionsOf(instanceId, claim.entry)
    // Once returned to the vault, only actual pending bytes are eligible for a new claim.
    requeue(bound, bound.entry)
  }
  // Reads `claim.entry`: closes of sibling tabs may supersede sessions meanwhile.
  const hydrate = () => {
    const eligible = emptySessionsOf(instanceId, claim.entry)
    const valid = new Set(getSessions(instanceId).filter(session => !session.catalogSnapshot && isSessionInWorkspaceScope(instanceId, session.id)).map(({ id }) => id))
    const applied = hydrateWorkspacePromptState(instanceId, eligible, valid, NO_SESSION_DRAFT_SESSION_ID)
    for (const id of applied) if (pendingOwner(bound, id)) {
      (bound.receivedIds ??= new Set()).add(id)
    }
  }
  hydrate()
  return (async () => {
    await sessionsReady()
    if (!isCurrent()) return
    const absenceProofs = await hydrateRestoredSessionChain(instanceId, getRestoredSessionIds([
      Object.keys(claim.entry.drafts), Object.keys(claim.entry.attachments),
    ]), undefined, isCurrent, { verifyDrafts: true, reconcileDeparture: true })
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
