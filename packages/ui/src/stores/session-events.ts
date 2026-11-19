import { isSessionNotFoundError, type SessionInfo } from "@opencode/client"
import type {
  PermissionAsked,
  PermissionReplied,
  SessionCompactionEnded,
  SessionCreated,
  SessionExecutionFailed,
  SessionMoved,
  SessionRetryScheduled,
  SessionRevertCleared,
  SessionRevertCommitted,
  SessionRevertStaged,
  TuiToastShow,
} from "@opencode/client"
import { getLogger } from "../lib/logger"
import { reconcileSessionModel } from "./session-model-reconciliation"
import { handlePruningEvent } from "./session-pruning-events"
import type { EventSessionDeleted, NativeSessionEvent } from "../lib/sse-manager"
import {
  getPermissionId,
  getPermissionKind,
  getPermissionSessionId,
  getRequestIdFromPermissionReply,
} from "../types/permission"
import type { PermissionRequest } from "../types/permission"
import { showToastNotification, type ToastHandle, ToastVariant } from "../lib/notifications"
import { preferences } from "./preferences"
import {
  instances,
  markPermissionReplied,
  hasRepliedPermission,
  reconcilePendingSessionIndicators,
  setPendingFormAddedHandler,
} from "./instances"
import { showAlertDialog } from "./alerts"
import {
  createClientSession,
  getIdleSinceForStatusTransition,
  mapNativeSessionRetry,
  type Session,
  type SessionRetryState,
  type SessionStatus,
} from "../types/session"
import { activeSessionId, forgetSessionMovedAway, getAuthoritativelyDeletedSessionIdsForInstance, getMovedAwaySessions, invalidateSessionMessageLoad, markSessionMovedAway, isSessionInWorkspaceScope, prependSessionListId, sessions, setSessionStatus, setSessions, withSession } from "./session-state"
import { mergeFetchedSessionRuntimeState } from "./session-generation-recovery"
import { showsRequestOfSession } from "./interruption-scope"
import { getRetrySeconds } from "./session-status"
import { observeSessionInterruption, retireSessionInterruptionBoundary } from "./session-interruption-seen"
import { tGlobal } from "../lib/i18n"

import { fetchSessions, invalidateRestorePlacementRead, loadMessages, refreshSessionCatalog, removeSessionProjection, removeSessionRuntimeState } from "./session-api"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { getWorktrees, onWorktreesPublished, reloadWorktrees } from "./worktrees"
import { isWorkspaceSessionDirectory } from "./workspace-session-scope"
import { isWorkspaceServedDirectory } from "./workspace-served-directory"
import { locationAuthorityKey } from "./request-locations"
import { workspaceSessionPlacementHeaders } from "../lib/sdk-manager"
import { prioritizedRead } from "../lib/prioritized-read"
import { SESSION_LOCATED_ELSEWHERE_REASON } from "../../../server/src/opencode/session-access-contract"
import {
  setSessionRevertV2,
} from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import { updateSessionInfo } from "./message-v2/session-info"
import { handleConversationAssistantPartUpdated } from "./conversation-speech"
import { createCompactionNoticeClaims, createSessionBubbles } from "./compaction-notice"

const log = getLogger("sse")
const claimCompactionNotice = createCompactionNoticeClaims()
const compactionBubbles = createSessionBubbles()
const COMPACTION_TOAST_MS = 10000
const pendingSessionFetches = new Map<string, {
  status: SessionStatus
  retry?: SessionRetryState | null
  /** Settles once the session's metadata read ends. */
  settled: Promise<void>
}>()
const nativeLifecycleGenerations = new Map<string, number>()
// The live backoff countdown of one session; it ends when that session's next
// attempt starts or its run settles.
let activeRetryToast: { key: string; handle: ToastHandle } | null = null
const movedSessionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
interface SessionMove { data: SessionMoved["data"]; unresolved?: boolean }
/** Per instance, the latest move of each session since its last refresh. */
const pendingSessionMoves = new Map<string, Map<string, SessionMove>>()
/** A move remains current until its placement is settled or superseded. */
const latestSessionMoves = new Map<string, Map<string, SessionMove>>()
type SessionPlacement = Pick<Session, "location" | "projectID" | "subpath"> & { listWorktreeSlug?: string }
type SessionPlacementRead = SessionInfo & { listWorktreeSlug?: string }
type PlacementEvidence = { placement: SessionPlacement; generation: number; client: ReturnType<typeof getRootClient> }
const confirmedPlacements = new Map<string, Map<string, PlacementEvidence>>()
const LOCATED_ELSEWHERE = Symbol("session located elsewhere")
const SESSION_MISSING = Symbol("session not found")

export function captureSessionPlacementEvidence(instanceId: string, sessionId: string): () => boolean {
  const evidence = confirmedPlacements.get(instanceId)?.get(sessionId)
  return () => confirmedPlacements.get(instanceId)?.get(sessionId) === evidence
}

export function matchesSessionPlacement(placement: SessionPlacement | undefined, expected: SessionPlacement): boolean {
  return !!placement && locationAuthorityKey(placement.location) === locationAuthorityKey(expected.location)
    && placement.projectID === expected.projectID && placement.subpath === expected.subpath
}

export function confirmSessionPlacement(instanceId: string, sessionId: string, { location, projectID, subpath, listWorktreeSlug }: SessionPlacement): void {
  const client = instances().get(instanceId)?.client
  if (!client) return
  const placements = confirmedPlacements.get(instanceId) ?? new Map<string, PlacementEvidence>()
  placements.set(sessionId, { placement: { location, projectID, subpath, listWorktreeSlug }, client, generation: getOpenCodeInstanceGeneration(instanceId) })
  confirmedPlacements.set(instanceId, placements)
}

/** Registered checkout identity; execution keeps the native directory. */
export function confirmedSessionWorktree(instanceId: string, sessionId: string, placement: SessionPlacement) {
  const confirmed = confirmedPlacements.get(instanceId)?.get(sessionId)
  const slug = confirmed?.placement.listWorktreeSlug
  if (slug && confirmed.client === instances().get(instanceId)?.client && matchesSessionPlacement(placement, confirmed.placement)) {
    return getWorktrees(instanceId).find(worktree => worktree.slug === slug)
  }
}

export function confirmedSessionListDirectory(instanceId: string, sessionId: string, placement: SessionPlacement): string | undefined {
  return confirmedSessionWorktree(instanceId, sessionId, placement)?.directory
}

/** A matching expired proof retains the row until a current probe can settle it. */
export function retainConfirmedSessionPlacement(
  instanceId: string, sessionId: string, placement: SessionPlacement | undefined,
  revalidations: Map<string, () => Promise<void>>, isCurrent: () => boolean, signal?: AbortSignal,
): boolean {
  const confirmed = confirmedPlacements.get(instanceId)?.get(sessionId)
  if (!confirmed || !matchesSessionPlacement(placement, confirmed.placement)) return false
  if (confirmed.client === instances().get(instanceId)?.client && confirmed.generation === getOpenCodeInstanceGeneration(instanceId)) return true
  revalidations.set(sessionId, async () => {
    const current = () => isCurrent() && !signal?.aborted && !isSessionMovePending(instanceId, sessionId)
      && confirmedPlacements.get(instanceId)?.get(sessionId) === confirmed
      && matchesSessionPlacement(sessions().get(instanceId)?.get(sessionId), confirmed.placement)
    const readSignal = signal ?? new AbortController().signal
    try {
      const result = await prioritizedRead(
        () => activeSessionId().get(instanceId) === sessionId,
        readSignal,
        () => current() ? readWorkspaceSessionPlacement(instanceId, sessionId, readSignal) : Promise.resolve(undefined),
      )
      if (!current()) return
      if (result === LOCATED_ELSEWHERE || result === SESSION_MISSING) {
        clearPendingSessionMove(instanceId, sessionId)
        if (result === LOCATED_ELSEWHERE) markSessionMovedAway(instanceId, sessionId, null)
        removeSessionProjection(instanceId, sessionId)
      } else if (result?.id === sessionId && result.location) {
        confirmSessionPlacement(instanceId, sessionId, result)
        if (!matchesSessionPlacement(result, confirmed.placement) || result.listWorktreeSlug !== confirmed.placement.listWorktreeSlug) {
          applySessionMovePlacement(instanceId, { ...result, sessionID: sessionId })
          refreshSelectedMoveCatalog(instanceId, sessionId)
        }
      }
    } catch (error) {
      if (current()) log.warn("Failed to revalidate session placement", { instanceId, sessionId, error })
    }
  })
  return true
}

async function readWorkspaceSessionPlacement(instanceId: string, sessionId: string, signal?: AbortSignal) {
  try {
    return await getRootClient(instanceId).session.get({ sessionID: sessionId }, {
      headers: workspaceSessionPlacementHeaders, signal,
    }) as SessionPlacementRead
  } catch (error) {
    if (isSessionNotFoundError(error)) {
      return "reason" in error && error.reason === SESSION_LOCATED_ELSEWHERE_REASON ? LOCATED_ELSEWHERE : SESSION_MISSING
    }
    throw error
  }
}

function advanceNativeLifecycle(instanceId: string, sessionId: string): number {
  const key = `${instanceId}\0${sessionId}`
  const generation = (nativeLifecycleGenerations.get(key) ?? 0) + 1
  nativeLifecycleGenerations.set(key, generation)
  return generation
}

function isCurrentNativeLifecycle(instanceId: string, sessionId: string, generation: number): boolean {
  return nativeLifecycleGenerations.get(`${instanceId}\0${sessionId}`) === generation
}

function dismissRetryToast(instanceId: string, sessionId: string): void {
  if (activeRetryToast?.key !== `${instanceId}\0${sessionId}`) return
  activeRetryToast.handle.dismiss()
  activeRetryToast = null
}

function speakCompletedAssistantText(instanceId: string, sessionId: string): void {
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageId = store.getLastAssistantMessageId(sessionId)
  const message = messageId ? store.getMessage(messageId) : undefined
  if (!messageId || message?.status !== "complete") return
  const info = store.getMessageInfo(messageId)
  for (const partId of message.partIds) {
    handleConversationAssistantPartUpdated(instanceId, message.parts[partId].data, info)
  }
}

function handleNativeSessionEvent(instanceId: string, event: NativeSessionEvent): void | Promise<void> {
  if (handlePruningEvent(instanceId, event)) return
  switch (event.type) {
    case "form.created":
    case "form.replied":
    case "form.cancelled":
      return
    case "session.archived":
    case "session.unarchived":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      withSession(instanceId, event.data.sessionID, session => {
        const { archived: _archived, ...time } = session.time
        session.time = { ...time, updated: Math.max(time.updated, event.created),
          ...(event.type === "session.archived" ? { archived: event.created } : {}) }
      })
      return
    case "session.renamed":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      withSession(instanceId, event.data.sessionID, (session) => { session.title = event.data.title })
      return
    case "session.agent.selected":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      withSession(instanceId, event.data.sessionID, (session) => { session.agent = event.data.agent })
      return
    case "session.model.selected":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) {
        void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
          .then(() => reconcileSessionModel(instanceId, event.data.sessionID))
      } else {
        void reconcileSessionModel(instanceId, event.data.sessionID)
      }
      return
    case "session.usage.updated":
      withSession(instanceId, event.data.sessionID, (session) => {
        session.cost = event.data.cost as unknown as number
        session.tokens = event.data.tokens as Session["tokens"]
      })
      updateSessionInfo(instanceId, event.data.sessionID)
      return
    case "session.moved":
      handleSessionMoved(instanceId, event.data)
      return
    case "session.forked":
      void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      return
    case "session.compaction.started":
      advanceNativeLifecycle(instanceId, event.data.sessionID)
      dismissRetryToast(instanceId, event.data.sessionID)
      ensureSessionStatus(instanceId, event.data.sessionID, "compacting", event.location?.directory)
      return
    case "session.compaction.failed":
      return reconcileTerminalNativeSessionStatus(instanceId, event.data.sessionID, {
        failed: true,
        directory: event.location?.directory,
      })
    case "session.execution.interrupted":
      return reconcileTerminalNativeSessionStatus(instanceId, event.data.sessionID, {
        failed: true,
        interruptedAt: event.created,
        refreshMessages: true,
        // A person's stop needs no notice and a shutdown resumes the turn later;
        // OpenCode stopping an unattended run does.
        notify: event.data.reason === "inactivity",
        directory: event.location?.directory,
      })
    case "session.execution.succeeded":
      return reconcileTerminalNativeSessionStatus(instanceId, event.data.sessionID, {
        failed: false,
        notify: true,
        directory: event.location?.directory,
      })
    case "session.retry.scheduled":
      handleRetryScheduled(instanceId, event)
      return
  }

  if (!event.type.startsWith("session.")) return
  const sessionId = "sessionID" in event.data ? event.data.sessionID : undefined
  if (!sessionId) return
  if (
    event.type === "session.execution.started" ||
    event.type === "session.step.started" ||
    event.type === "session.step.streamed" ||
    event.type.startsWith("session.text.") ||
    event.type.startsWith("session.reasoning.") ||
    event.type.startsWith("session.tool.")
  ) {
    if (event.type === "session.execution.started") retireSessionInterruptionBoundary(instanceId, sessionId)
    advanceNativeLifecycle(instanceId, sessionId)
    // Ordinary work replaces the backoff: the next attempt has started.
    dismissRetryToast(instanceId, sessionId)
    ensureSessionStatus(instanceId, sessionId, "working", event.location?.directory)
  }
}

/**
 * OpenCode V2 settles each busy period with one session.execution.* event. It is
 * a hint until the native active list confirms the session no longer runs; only
 * then does the run count as finished (`notify` announces that completion).
 */
async function reconcileTerminalNativeSessionStatus(
  instanceId: string,
  sessionId: string,
  options: { failed: boolean; interruptedAt?: number; refreshMessages?: boolean; notify?: boolean; directory?: string },
): Promise<void> {
  const generation = advanceNativeLifecycle(instanceId, sessionId)
  // Claim this event before any refresh can expose its badge for acknowledgement.
  const current = sessions().get(instanceId)?.get(sessionId)
  if (current && options.interruptedAt !== undefined) observeSessionInterruption(instanceId, current, options.interruptedAt)
  let activeSessions: Record<string, unknown> | null = null
  try {
    activeSessions = await getRootClient(instanceId).session.active()
  } catch (error) {
    log.warn("Failed to reconcile terminal session state", { instanceId, sessionId, error })
  }
  if (!isCurrentNativeLifecycle(instanceId, sessionId, generation)) return

  if (activeSessions && Object.prototype.hasOwnProperty.call(activeSessions, sessionId)) {
    withSession(instanceId, sessionId, (session) => { session.generationRecovery = null })
    const existing = sessions().get(instanceId)?.get(sessionId)
    if (existing) setSessionStatus(instanceId, sessionId, "working", { force: true })
    else ensureSessionStatus(instanceId, sessionId, "working", options.directory)
    return
  }

  if (options.interruptedAt !== undefined) {
    withSession(instanceId, sessionId, (session) => { session.generationRecovery = "interrupted" })
  }
  setTerminalNativeSessionStatus(instanceId, sessionId, options.failed, options.directory)
  refreshSettledSessionMessages(instanceId, sessionId, options.refreshMessages)
  if (options.notify) notifySessionAttention("sessionDone", instanceId, sessionId)
}

function refreshSettledSessionMessages(instanceId: string, sessionId: string, force = false): void {
  // The native reducer can reconcile its own cache after a missing tool terminal
  // event, but our bounded visible message store needs an authoritative load too.
  const store = messageStoreBus.getInstance(instanceId)
  const unsettledTools = store?.getSessionMessageIds(sessionId).some(id => {
    const message = store.getMessage(id)
    return message?.partIds.some(partId => {
      const part = message.parts[partId]?.data
      return part?.type === "tool" && (part.state?.status === "pending" || part.state?.status === "running")
    })
  })
  if (force || unsettledTools) {
    void loadMessages(instanceId, sessionId, { force: true }).catch((error) => {
      log.warn("Failed to refresh settled session messages", { instanceId, sessionId, error })
    })
  }
}

function setTerminalNativeSessionStatus(instanceId: string, sessionId: string, failed: boolean, directory?: string): void {
  const existing = sessions().get(instanceId)?.get(sessionId)
  if (existing) setSessionStatus(instanceId, sessionId, "idle", { force: true })
  else ensureSessionStatus(instanceId, sessionId, "idle", directory)
  dismissRetryToast(instanceId, sessionId)
  if (failed) messageStoreBus.getOrCreate(instanceId).failPendingSends(sessionId)
  speakCompletedAssistantText(instanceId, sessionId)
}

function listsSessionDirectory(instanceId: string, directory: string): boolean {
  const instance = instances().get(instanceId)
  return Boolean(instance) && isWorkspaceSessionDirectory(directory, instance!.folder, getWorktrees(instanceId))
}

/** Whether the display inventory recognizes this directory spelling. */
function servesSessionDirectory(instanceId: string, directory: string): boolean {
  const instance = instances().get(instanceId)
  return Boolean(instance) && isWorkspaceServedDirectory(directory, instance!.folder, getWorktrees(instanceId))
}

function applySessionMovePlacement(instanceId: string, { sessionID, location, projectID, subpath }: SessionMoved["data"]): void {
  withSession(instanceId, sessionID, (session) => {
    session.location = location
    session.projectID = projectID
    session.subpath = subpath
  })
}

async function refreshMovedSessions(instanceId: string): Promise<void> {
  try {
    await fetchSessions(instanceId, { reset: true })
    if (activeSessionId().get(instanceId)) await refreshSessionCatalog(instanceId)
  } catch (error) {
    log.warn("Failed to reconcile moved sessions", { instanceId, error })
  }
}

function refreshSelectedMoveCatalog(instanceId: string, sessionId: string): void {
  if (activeSessionId().get(instanceId) === sessionId) {
    void refreshSessionCatalog(instanceId).catch((error) => {
      log.warn("Failed to refresh moved session catalog", { instanceId, sessionId, error })
    })
  }
}

function handleSessionMoved(instanceId: string, data: SessionMoved["data"]): void {
  const { sessionID: sessionId, location } = data
  invalidateRestorePlacementRead(instanceId, sessionId)
  // The relay delivers each move to both owners in their own ordered streams.
  // Forwarding it here could supersede a later move in another instance.
  if (listsSessionDirectory(instanceId, location.directory)) {
    applySessionMovePlacement(instanceId, data)
    refreshSelectedMoveCatalog(instanceId, sessionId)
  }

  const move: SessionMove = { data }
  confirmedPlacements.get(instanceId)?.delete(sessionId)
  const latest = latestSessionMoves.get(instanceId) ?? new Map()
  latest.set(sessionId, move)
  latestSessionMoves.set(instanceId, latest)
  forgetSessionMovedAway(instanceId, sessionId)
  pendingSessionMoves.set(instanceId, (pendingSessionMoves.get(instanceId) ?? new Map()).set(sessionId, move))
  const pending = movedSessionRefreshTimers.get(instanceId)
  if (pending) clearTimeout(pending)
  movedSessionRefreshTimers.set(instanceId, setTimeout(() => {
    movedSessionRefreshTimers.delete(instanceId)
    const moves = pendingSessionMoves.get(instanceId) ?? new Map<string, SessionMove>()
    pendingSessionMoves.delete(instanceId)
    void reloadWorktrees(instanceId).catch(error => {
      log.warn("Failed to refresh moved-session worktrees", { instanceId, error })
    }).then(() => Promise.all([...moves].map(([movedId, move]) => settleSessionMove(instanceId, movedId, move))))
      .then(() => refreshMovedSessions(instanceId))
  }, 100))
}

async function settleSessionMove(instanceId: string, sessionId: string, move: SessionMove, fresh = false): Promise<boolean> {
  const instance = instances().get(instanceId)
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const current = () => !!instance?.client && instances().get(instanceId)?.client === instance.client
    && isInstanceGenerationCurrent(instanceId, generation) && getPendingSessionMove(instanceId, sessionId) === move
  if (!current()) return false
  const needsFresh = move.unresolved || !listsSessionDirectory(instanceId, move.data.location.directory)
  move.unresolved = false
  let inventoryKnown = fresh || !needsFresh
  if (!inventoryKnown) {
    try {
      await reloadWorktrees(instanceId, true)
      inventoryKnown = true
    } catch (error) {
      log.warn("Failed to read the inventory for a moved session", { instanceId, sessionId, error })
    }
  }
  if (!current()) {
    move.unresolved = true
    return false
  }
  if (inventoryKnown && listsSessionDirectory(instanceId, move.data.location.directory)) {
    return finishSessionMove(instanceId, sessionId, move, move.data)
  }
  // Containment alone cannot distinguish a registered checkout alias from a nested repo.
  try {
    const session = await readWorkspaceSessionPlacement(instanceId, sessionId)
    if (current()) {
      if (session === LOCATED_ELSEWHERE || session === SESSION_MISSING) return finishSessionMove(instanceId, sessionId, move, session)
      if (session?.id === sessionId && session.location) return finishSessionMove(instanceId, sessionId, move, session, session)
    }
  } catch (error) {
    log.warn("Failed to confirm moved session placement", { instanceId, sessionId, error })
  }
  move.unresolved = true
  return false
}

function finishSessionMove(instanceId: string, sessionId: string, move: SessionMove, placement: SessionPlacement | typeof LOCATED_ELSEWHERE | typeof SESSION_MISSING, verified?: SessionPlacementRead): boolean {
  if (getPendingSessionMove(instanceId, sessionId) !== move) return false
  clearPendingSessionMove(instanceId, sessionId)
  if (!instances().has(instanceId) || getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) return false
  const { directory } = move.data.location
  if (typeof placement !== "symbol") {
    if (verified) confirmSessionPlacement(instanceId, sessionId, placement)
    const held = sessions().get(instanceId)?.get(sessionId)
    if (held) applySessionMovePlacement(instanceId, { ...placement, sessionID: sessionId })
    else if (verified && confirmedSessionListDirectory(instanceId, sessionId, placement)) {
      publishFetchedSessionInfo(instanceId, verified, undefined)
    }
    return true
  }
  if (placement === LOCATED_ELSEWHERE) markSessionMovedAway(instanceId, sessionId, directory)
  if (!sessions().get(instanceId)?.has(sessionId)) return true
  nativeLifecycleGenerations.delete(`${instanceId}\0${sessionId}`)
  dismissRetryToast(instanceId, sessionId)
  removeSessionProjection(instanceId, sessionId)
  return true
}

export function getPendingSessionMove(instanceId: string, sessionId: string): SessionMove | undefined {
  return latestSessionMoves.get(instanceId)?.get(sessionId)
}

export function clearPendingSessionMove(instanceId: string, sessionId?: string): void {
  const confirmed = confirmedPlacements.get(instanceId)
  if (sessionId !== undefined) confirmed?.delete(sessionId)
  if (sessionId === undefined || !confirmed?.size) confirmedPlacements.delete(instanceId)
  const moves = latestSessionMoves.get(instanceId)
  if (sessionId !== undefined) moves?.delete(sessionId)
  if (sessionId === undefined || !moves?.size) latestSessionMoves.delete(instanceId)
  if (sessionId === undefined) {
    clearTimeout(movedSessionRefreshTimers.get(instanceId))
    movedSessionRefreshTimers.delete(instanceId)
    pendingSessionMoves.delete(instanceId)
  }
}

export function isSessionMovePending(instanceId: string, sessionId: string): boolean {
  return getPendingSessionMove(instanceId, sessionId) !== undefined
}

/** A later inventory that serves a moved-away session's destination lists it again. */
function relistReturnedSessions(instanceId: string): void {
  const returned = [...getMovedAwaySessions(instanceId)].filter(([, directory]) => directory !== null && servesSessionDirectory(instanceId, directory)).map(([id]) => id)
  if (!returned.length) return
  for (const id of returned) forgetSessionMovedAway(instanceId, id)
  void fetchSessions(instanceId, { reset: true }).catch((error) => {
    log.warn("Failed to list returned moved sessions", { instanceId, error })
  })
}

function isChildSession(instanceId: string, sessionId: string): boolean | null {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return null
  return session.parentId !== null && session.parentId !== undefined
}

/** Session attention notifications concern root sessions only. */
function isNotifiableSession(instanceId: string, sessionId: string | undefined | null, category: "needsInput" | "sessionDone"): boolean {
  if (!sessionId) return true
  // A held session outside the workspace scope belongs to another project's
  // list; its request still notifies where this project's dock shows it.
  if (sessions().get(instanceId)?.has(sessionId) && !isSessionInWorkspaceScope(instanceId, sessionId)
    && (category !== "needsInput" || !showsRequestOfSession(instanceId, sessionId))) return false

  const child = isChildSession(instanceId, sessionId)

  // Avoid notification spam from spawned child/subagent sessions arriving before hydration.
  if (child === null) return false
  if (child) return false

  return true
}

function getInstanceDisplayName(instanceId: string): string {
  const instanceFolder = instances().get(instanceId)?.folder ?? instanceId
  return instanceFolder.split(/[\\/]/).filter(Boolean).pop() ?? instanceFolder
}

function getSessionTitle(instanceId: string, sessionId: string | undefined | null): string {
  if (!sessionId) return ""
  const session = sessions().get(instanceId)?.get(sessionId)
  const title = session?.title?.trim()
  return title && title.length > 0 ? title : sessionId
}

/** Routed like every notification: screen, history and/or system per Settings → Notifications. */
function notifySessionAttention(category: "needsInput" | "sessionDone", instanceId: string, sessionId: string | undefined | null): void {
  if (!isNotifiableSession(instanceId, sessionId, category)) return
  const label = getSessionTitle(instanceId, sessionId)
  const message = label
    ? tGlobal(category === "needsInput" ? "sessionEvents.notify.needsInput" : "sessionEvents.notify.done", { label })
    : tGlobal(`settings.notifications.category.${category}`)
  showToastNotification({ category, title: getInstanceDisplayName(instanceId), message, variant: "info" })
}

queueMicrotask(() => {
  onWorktreesPublished((instanceId, fresh) => {
    relistReturnedSessions(instanceId)
    const retries: Promise<boolean>[] = []
    for (const [sessionId, move] of latestSessionMoves.get(instanceId) ?? []) {
      if (!move.unresolved) continue
      retries.push(settleSessionMove(instanceId, sessionId, move, fresh))
    }
    if (retries.length) void Promise.all(retries).then(results => {
      if (results.some(Boolean)) return refreshMovedSessions(instanceId)
    })
  })
  setPendingFormAddedHandler((instanceId, form) => notifySessionAttention("needsInput", instanceId, form.sessionID))
})

const ALLOWED_TOAST_VARIANTS = new Set<ToastVariant>(["info", "success", "warning", "error"])

/** Whether the project is still open on the OpenCode data generation captured earlier. */
function isInstanceGenerationCurrent(instanceId: string, generation: number): boolean {
  return instances().has(instanceId) && getOpenCodeInstanceGeneration(instanceId) === generation
}

async function fetchSessionInfo(instanceId: string, sessionId: string, directory?: string): Promise<Session | null> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return null

  const client = getRootClient(instanceId)
  void directory
  const generation = getOpenCodeInstanceGeneration(instanceId)

  try {
    const captured = sessions().get(instanceId)?.get(sessionId)
    const info = await client.session.get({ sessionID: sessionId })
    // A project closed or a client replaced during the read publishes nothing.
    if (!isInstanceGenerationCurrent(instanceId, generation)) return null
    return publishFetchedSessionInfo(instanceId, info, captured)
  } catch (error) {
    log.error("Failed to fetch session info", error)
    return null
  }
}

function publishFetchedSessionInfo(instanceId: string, info: SessionInfo, captured: Session | undefined): Session {
  const sessionId = info.id
  const fetched = createClientSession(info, instanceId)
  let updatedInstanceSessions: Map<string, Session> | undefined

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = new Map(prev.get(instanceId))
    const existing = instanceSessions.get(sessionId)
    const compacting = existing?.status === "compacting"
    const candidate: Session = {
      ...fetched,
      agent: existing?.agent ?? fetched.agent,
      model: existing?.model ?? fetched.model,
      status: compacting ? "compacting" : fetched.status,
      retry: compacting ? null : fetched.retry,
      idleSince: getIdleSinceForStatusTransition(existing?.status, compacting ? "compacting" : fetched.status, existing?.idleSince),
      pendingPermission: existing?.pendingPermission ?? fetched.pendingPermission,
      pendingForm: existing?.pendingForm ?? false,
      runtimeStatusKnown: compacting || existing?.runtimeStatusKnown || false,
    }
    const merged = mergeFetchedSessionRuntimeState(
      candidate,
      captured,
      existing,
      getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId),
    )
    if (!merged) return prev
    instanceSessions.set(sessionId, merged)
    next.set(instanceId, instanceSessions)
    updatedInstanceSessions = instanceSessions
    return next
  })

  reconcilePendingSessionIndicators(instanceId)

  const published = updatedInstanceSessions?.get(sessionId)
  if (published && !published.parentId) prependSessionListId(instanceId, sessionId)

  return fetched
}

function ensureSessionStatus(
  instanceId: string,
  sessionId: string,
  status: SessionStatus,
  directory?: string,
  retry?: SessionRetryState | null,
): Promise<void> {
  const existing = sessions().get(instanceId)?.get(sessionId)
  if (existing) {
    setSessionStatus(instanceId, sessionId, status, { retry })
    return Promise.resolve()
  }

  // Reads coalesce within one instance generation: a replaced client reads again.
  const key = `${instanceId}:${getOpenCodeInstanceGeneration(instanceId)}:${sessionId}`
  const existingFetch = pendingSessionFetches.get(key)
  if (existingFetch) {
    existingFetch.status = status
    existingFetch.retry = retry
    return existingFetch.settled
  }

  const pendingState: { status: SessionStatus; retry?: SessionRetryState | null; settled: Promise<void> } = { status, retry, settled: Promise.resolve() }
  const pending = (async () => {
    const fetched = await fetchSessionInfo(instanceId, sessionId, directory)
    if (!fetched) return
    setSessionStatus(instanceId, sessionId, pendingState.status, { retry: pendingState.retry })
  })()

  pendingState.settled = pending
  pendingSessionFetches.set(key, pendingState)
  void pending.finally(() => {
    if (pendingSessionFetches.get(key) === pendingState) pendingSessionFetches.delete(key)
  })
  return pending
}

function handleSessionUpdate(
  instanceId: string,
  event: SessionCreated | SessionRevertStaged | SessionRevertCleared | SessionRevertCommitted,
): void {
  if (event.type !== "session.created") {
    const revert = event.type === "session.revert.staged" ? event.data.revert : null
    setSessionRevertV2(instanceId, event.data.sessionID, revert)
    withSession(instanceId, event.data.sessionID, (session) => {
      session.revert = revert ?? undefined
    })
    if (event.type === "session.revert.cleared") {
      // The staged tail is still owned by OpenCode, but no longer resident.
      // Clearing the marker alone cannot render it again.
      const sessionId = event.data.sessionID
      invalidateSessionMessageLoad(instanceId, sessionId)
      if (activeSessionId().get(instanceId) === sessionId) {
        void loadMessages(instanceId, sessionId, { force: true }).catch((error) => {
          log.error("Failed to reload messages after clearing revert", error)
        })
      }
    }
    return
  }

  const info = {
    ...event.data,
    id: event.data.sessionID,
    time: { created: event.created, updated: event.created },
  }
  if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(info.id)) return

  const instanceSessions = sessions().get(instanceId) ?? new Map<string, Session>()

  const existingSession = instanceSessions.get(info.id)

  if (!existingSession) {
    const newSession = {
      id: info.id,
      instanceId,
      title: info.title || tGlobal("sessionList.session.untitled"),
      parentId: info.parentID || null,
      agent: info.agent ?? "",
      model: info.model
        ? { providerId: info.model.providerID, modelId: info.model.id }
        : { providerId: "", modelId: "" },
      status: "idle",
      retry: null,
      idleSince: null,
      version: info.version || "0",
      projectID: info.projectID,
      metadata: info.metadata,
      cost: (info as any).cost ?? 0,
      tokens: (info as any).tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      location: info.location,
      time: info.time
        ? { ...info.time }
        : {
            created: Date.now(),
            updated: Date.now(),
          },
    } as Session

    let updatedInstanceSessions: Map<string, Session> | undefined

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      instanceSessions.set(newSession.id, newSession)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions
      return next
    })

    if (!newSession.parentId) {
      prependSessionListId(instanceId, newSession.id)
    }

    log.info(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    const mergedTime = {
      ...existingSession.time,
      ...(info.time ?? {}),
    }
    const updatedSession = {
      ...existingSession,
      title: info.title || existingSession.title,
      parentId: info.parentID ?? existingSession.parentId,
      metadata: info.metadata ?? existingSession.metadata,
      status: existingSession.status ?? "idle",
      retry: existingSession.retry ?? null,
      time: mergedTime,
    }

    let updatedInstanceSessions: Map<string, Session> | undefined

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      instanceSessions.set(existingSession.id, updatedSession)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions
      return next
    })

  }
  reconcilePendingSessionIndicators(instanceId)
}

function handleSessionDeleted(instanceId: string, event: EventSessionDeleted): void {
  const sessionId = event.data?.sessionID
  if (!sessionId) return

  log.info(`[SSE] Session deleted: ${sessionId}`)
  nativeLifecycleGenerations.delete(`${instanceId}\0${sessionId}`)
  dismissRetryToast(instanceId, sessionId)
  removeSessionRuntimeState(instanceId, sessionId, "observation")
}

/** Native provider backoff. The next attempt's step events clear it as ordinary work. */
function handleRetryScheduled(instanceId: string, event: SessionRetryScheduled): void {
  const sessionId = event.data.sessionID
  const generation = advanceNativeLifecycle(instanceId, sessionId)
  const instanceGeneration = getOpenCodeInstanceGeneration(instanceId)
  const retry = mapNativeSessionRetry(event.data)
  const held = sessions().get(instanceId)?.has(sessionId)
  const resolved = ensureSessionStatus(instanceId, sessionId, "working", event.location?.directory, retry)
  if (held) showRetryToast(instanceId, sessionId, retry)
  // An unknown session's scope is known once its metadata is read and
  // published; by then the next attempt may have replaced this backoff, or
  // the project may have closed.
  else void resolved.then(() => {
    if (isInstanceGenerationCurrent(instanceId, instanceGeneration) && sessions().get(instanceId)?.has(sessionId)
      && isCurrentNativeLifecycle(instanceId, sessionId, generation)) showRetryToast(instanceId, sessionId, retry)
  })
}

function showRetryToast(instanceId: string, sessionId: string, retry: SessionRetryState): void {
  // Shown by the project whose list shows the session, not by an owning parent.
  if (sessions().get(instanceId)?.has(sessionId) && !isSessionInWorkspaceScope(instanceId, sessionId)) return
  const remainingSeconds = getRetrySeconds(retry.next)
  const countdown =
    remainingSeconds > 0
      ? tGlobal("sessionList.status.retryingIn", { seconds: String(remainingSeconds) })
      : tGlobal("sessionList.status.retrying")
  const label = getSessionTitle(instanceId, sessionId)
  activeRetryToast?.handle.dismiss()
  // A live retry status replaced by the next attempt, not an event to keep.
  activeRetryToast = { key: `${instanceId}\0${sessionId}`, handle: showToastNotification({ category: "sessions", transient: true,
    title: label || getInstanceDisplayName(instanceId),
    message: tGlobal("sessionList.status.retryToast", {
      countdown,
      message: retry.message,
      attempt: String(retry.attempt),
    }),
    variant: "error",
    duration: 7000,
  }) }
}

function handleSessionCompacted(instanceId: string, event: SessionCompactionEnded): void {
  const sessionID = event.data.sessionID
  if (!sessionID) return

  log.info(`[SSE] Session compacted: ${sessionID}`)
  advanceNativeLifecycle(instanceId, sessionID)

  const existing = sessions().get(instanceId)?.get(sessionID)
  if (existing) {
    setSessionStatus(instanceId, sessionID, "working", { force: true })
    announceCompaction(instanceId, event)
  } else {
    // An unknown session's scope is known once its metadata is read and
    // published; a failed read, a deletion or a closed project announces nothing.
    const instanceGeneration = getOpenCodeInstanceGeneration(instanceId)
    void ensureSessionStatus(instanceId, sessionID, "working", event.location?.directory).then(() => {
      if (isInstanceGenerationCurrent(instanceId, instanceGeneration) && sessions().get(instanceId)?.has(sessionID)) announceCompaction(instanceId, event)
    })
  }
}

function announceCompaction(instanceId: string, event: SessionCompactionEnded): void {
  const sessionID = event.data.sessionID
  // Announced by the project whose list shows the session, not by an owning parent.
  if (sessions().get(instanceId)?.has(sessionID) && !isSessionInWorkspaceScope(instanceId, sessionID)) return
  if (!claimCompactionNotice(event)) return
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionID)
  const label = session?.title?.trim() ? session.title : sessionID
  const instanceFolder = instances().get(instanceId)?.folder ?? instanceId
  const instanceName = instanceFolder.split(/[\\/]/).filter(Boolean).pop() ?? instanceFolder
  const displayLabel = label ? `"${label}"` : sessionID

  compactionBubbles.show(sessionID, COMPACTION_TOAST_MS, () => showToastNotification({ category: "sessions",
    title: instanceName,
    message: tGlobal("sessionEvents.sessionCompactedToast", { label: displayLabel }),
    variant: "info",
    duration: COMPACTION_TOAST_MS,
  }))
}

function handleSessionError(instanceId: string, event: SessionExecutionFailed): void {
  const error = event.data.error
  const sessionId = event.data.sessionID
  if (sessionId) {
    void reconcileTerminalNativeSessionStatus(instanceId, sessionId, {
      failed: true,
      // The alert stays in this window; the notice reaches history and the system.
      notify: true,
      directory: event.location?.directory,
    })
  }
  log.error(`[SSE] Session error:`, error)

  const message = typeof error?.message === "string" ? error.message : tGlobal("sessionEvents.sessionError.unknown")

  showAlertDialog(tGlobal("sessionEvents.sessionError.message", { message }), {
    title: tGlobal("sessionEvents.sessionError.title"),
    variant: "error",
  })
}

function handleTuiToast(_instanceId: string, event: TuiToastShow): void {
  const payload = event.data
  if (!payload || typeof payload.message !== "string" || typeof payload.variant !== "string") return
  if (!payload.message.trim()) return

  const variant: ToastVariant = ALLOWED_TOAST_VARIANTS.has(payload.variant as ToastVariant)
    ? (payload.variant as ToastVariant)
    : "info"

  showToastNotification({ category: "opencode",
    title: typeof payload.title === "string" ? payload.title : undefined,
    message: payload.message,
    variant,
    duration: typeof payload.duration === "number" ? payload.duration : undefined,
  })
}

function handlePermissionUpdated(instanceId: string, event: PermissionAsked): void {
  const permission = event.data as PermissionRequest
  if (!permission) return
  const permissionId = getPermissionId(permission)
  if (!permissionId) return
  if (hasRepliedPermission(instanceId, permissionId)) {
    log.info(`[SSE] Ignoring stale permission request after local reply: ${permissionId}`)
    return
  }
  log.info(`[SSE] Permission request: ${permissionId} (${getPermissionKind(permission)})`)

  notifySessionAttention("needsInput", instanceId, getPermissionSessionId(permission))
}

function handlePermissionReplied(instanceId: string, event: PermissionReplied): void {
  const requestId = getRequestIdFromPermissionReply(event.data)
  if (!requestId) return

  log.info(`[SSE] Permission replied: ${requestId}`)
  markPermissionReplied(instanceId, requestId)
}

export {
  handleNativeSessionEvent,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleSessionCompacted,
  handleSessionDeleted,
  handleSessionError,
  handleSessionUpdate,
  handleTuiToast,
}
