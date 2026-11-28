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
import { backendEvents } from "../lib/server-events"
import { parseInstanceKey } from "../lib/backend-identity"
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
import { showToastNotification, type ToastHandle, ToastVariant, type ToastPayload } from "../lib/notifications"
import { uiState } from "./preferences"
import { getInstanceLabel } from "../lib/instance-label"
import { batch, createSignal } from "solid-js"
import { replaceSessionRow, setActiveSessionFromList } from "./session-state"
import { applySurface, beginGesture } from "./session-surface"
import {
  instances,
  markPermissionReplied,
  hasRepliedPermission,
  getSessionPendingIndicators,
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
import { activeSessionId, canRelistReturnedSession, forgetSessionMovedAway, getAuthoritativelyDeletedSessionIdsForInstance, getMovedAwaySessions, getSessionListIds, getSessionRoot, invalidateSessionMessageLoad, markSessionMovedAway, messagesLoaded, isSessionInWorkspaceScope, prependSessionListId, sessions, setSessionStatus, setSessions, withSession } from "./session-state"
import { isSessionTranscriptVisible } from "./session-transcript-visibility"
import { isLatestWindow } from "./message-v2/message-window"
import { mergeFetchedSessionRuntimeState } from "./session-generation-recovery"
import { showsRequestOfSession } from "./interruption-scope"
import { getRetrySeconds } from "./session-status"
import { observeSessionInterruption, retireSessionInterruptionBoundary } from "./session-interruption-seen"
import { tGlobal } from "../lib/i18n"

import { excludeMissingMoveFromSearch, fetchSessions, invalidateRestorePlacementRead, loadMessages, refreshSessionCatalog, removeSessionProjection, removeSessionRuntimeState } from "./session-api"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { getDirectoryOnlyWorktree, getWorktrees, onWorktreesPublished, reloadWorktrees } from "./worktrees"
import { isWorkspaceSessionDirectory } from "./workspace-session-scope"
import { isWorkspaceServedDirectory } from "./workspace-served-directory"
import { locationAuthorityKey } from "./request-locations"
import { workspaceSessionPlacementHeaders } from "../lib/sdk-manager"
import { prioritizedRead } from "../lib/prioritized-read"
import { SESSION_LOCATED_ELSEWHERE_REASON } from "../../../server/src/opencode/session-access-contract"
import { isReservedMissionScheduleSessionID } from "../../../server/src/missions/mission-schedule-carrier-identity"
import {
  setSessionRevertV2,
} from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import { updateSessionInfo } from "./message-v2/session-info"
import { handleConversationAssistantPartUpdated } from "./conversation-speech"
import { createCompactionNoticeClaims, createSessionBubbles } from "./compaction-notice"
import { TrailingResyncCoordinator } from "../lib/trailing-resync"

const log = getLogger("sse")
const claimCompactionNotice = createCompactionNoticeClaims()
const compactionBubbles = createSessionBubbles()
const COMPACTION_TOAST_MS = 10000
const pendingSessionFetches = new Map<string, {
  status: SessionStatus
  retry?: SessionRetryState | null
  lifecycle: number
  /** Settles once the session's metadata read ends. */
  settled: Promise<void>
  signal: AbortSignal
  current: () => boolean
}>()
const sessionInfoReads = new Map<string, {
  signal: AbortSignal
  current: () => boolean
  metadata: SessionInfoObservation
  result: Promise<Session | null>
}>()
type SessionInfoDelta =
  | { title: { value: string; at: number }; archive?: never }
  | { archive: { archived: boolean; at: number }; title?: never }
type SessionInfoObservation = {
  title?: { value: string; at: number }
  archive?: { archived: boolean; at: number }
  projectedArchive?: { time: Session["time"]; snapshotAt: number }
}
const nativeLifecycleGenerations = new Map<string, number>()
// The live backoff countdown of one session; it ends when that session's next
// attempt starts or its run settles.
const activeRetryToasts = new Map<string, { key: string; handle: ToastHandle }>()
const movedSessionRefreshTimers = new Map<string, () => void>()

function captureEventAuthority(instanceId: string) {
  const signal = backendEvents.signalForInstance(instanceId)
  const client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  return { signal, current: () => !signal?.aborted && instances().get(instanceId)?.client === client
    && getOpenCodeInstanceGeneration(instanceId) === generation }
}

interface SessionMove {
  authority: ReturnType<typeof captureEventAuthority>
  /** A reconnect keeps the read demand, not the old event's destination. */
  data?: SessionMoved["data"]
  unresolved?: boolean
  arrival?: { session: SessionPlacementRead; evidenceCurrent: () => boolean }
}
/** Per instance, the latest move of each session since its last refresh. */
const pendingSessionMoves = new Map<string, Map<string, SessionMove>>()
/** A move remains current until its placement is settled or superseded. */
const latestSessionMoves = new Map<string, Map<string, SessionMove>>()
type SessionPlacement = Pick<Session, "location" | "projectID" | "subpath"> & { listWorktreeSlug?: string }
type SessionPlacementRead = SessionInfo & { listWorktreeSlug?: string }
type PlacementEvidence = { placement: SessionPlacement; generation: number; client: ReturnType<typeof getRootClient>; returnFrom?: string | null }
const [placementEvidence, setPlacementEvidence] = createSignal(new Map<string, Map<string, PlacementEvidence>>())
const LOCATED_ELSEWHERE = Symbol("session located elsewhere")
const SESSION_MISSING = Symbol("session not found")

export function captureSessionPlacementEvidence(instanceId: string, sessionId: string): () => boolean {
  const evidence = placementEvidence().get(instanceId)?.get(sessionId)
  return () => placementEvidence().get(instanceId)?.get(sessionId) === evidence
}

export function getSessionPlacementEvidence(instanceId: string): ReadonlyMap<string, unknown> | undefined {
  return placementEvidence().get(instanceId)
}

export function matchesSessionPlacement(placement: SessionPlacement | undefined, expected: SessionPlacement): boolean {
  return !!placement && locationAuthorityKey(placement.location) === locationAuthorityKey(expected.location)
    && placement.projectID === expected.projectID && placement.subpath === expected.subpath
}

export function confirmSessionPlacement(instanceId: string, sessionId: string, { location, projectID, subpath, listWorktreeSlug }: SessionPlacement, returnFrom?: string | null): void {
  const client = instances().get(instanceId)?.client
  if (!client) return
  const evidence = { placement: { location, projectID, subpath, listWorktreeSlug }, client, generation: getOpenCodeInstanceGeneration(instanceId), returnFrom }
  setPlacementEvidence(previous => new Map(previous).set(instanceId, new Map(previous.get(instanceId)).set(sessionId, evidence)))
}

function clearPlacementEvidence(instanceId: string, sessionId?: string): void {
  setPlacementEvidence(previous => {
    const held = previous.get(instanceId)
    if (!held || (sessionId !== undefined && !held.has(sessionId))) return previous
    const next = new Map(previous)
    if (sessionId === undefined || held.size === 1) next.delete(instanceId)
    else {
      const placements = new Map(held)
      placements.delete(sessionId)
      next.set(instanceId, placements)
    }
    return next
  })
}

/** Registered checkout identity; execution keeps the native directory. */
export function confirmedSessionWorktree(instanceId: string, sessionId: string, placement: SessionPlacement) {
  const confirmed = placementEvidence().get(instanceId)?.get(sessionId)
  const slug = confirmed?.placement.listWorktreeSlug
  if (slug && confirmed.returnFrom === undefined && confirmed.client === instances().get(instanceId)?.client
    && matchesSessionPlacement(placement, confirmed.placement)) {
    return getWorktrees(instanceId).find(worktree => worktree.slug === slug)
  }
}

export function confirmedSessionListDirectory(instanceId: string, sessionId: string, placement: SessionPlacement): string | undefined {
  return confirmedSessionWorktree(instanceId, sessionId, placement)?.directory
}

export function hasPendingSessionReturn(instanceId: string, sessionId: string): boolean {
  return placementEvidence().get(instanceId)?.get(sessionId)?.returnFrom !== undefined
}

/** Expired proof or a changed pending return needs a current probe. */
export function retainConfirmedSessionPlacement(
  instanceId: string, sessionId: string, placement: SessionPlacement | undefined,
  revalidations: Map<string, () => Promise<void>>, isCurrent: () => boolean, signal?: AbortSignal,
): boolean {
  const confirmed = placementEvidence().get(instanceId)?.get(sessionId)
  if (!confirmed || !placement) return false
  const matching = matchesSessionPlacement(placement, confirmed.placement)
  const pendingReturn = confirmed.returnFrom !== undefined
    && getMovedAwaySessions(instanceId).get(sessionId) === confirmed.returnFrom
  if (!matching && !pendingReturn) return false
  if (matching && confirmed.client === instances().get(instanceId)?.client && confirmed.generation === getOpenCodeInstanceGeneration(instanceId)) {
    if (pendingReturn && isCurrent() && !signal?.aborted) settleListedReturn(instanceId, sessionId)
    return true
  }
  const capturedPlacement = { ...placement }
  const authority = captureEventAuthority(instanceId)
  revalidations.set(sessionId, async () => {
    const current = () => authority.current() && isCurrent() && !signal?.aborted && !isSessionMovePending(instanceId, sessionId)
      && placementEvidence().get(instanceId)?.get(sessionId) === confirmed
      && (confirmed.returnFrom === undefined || getMovedAwaySessions(instanceId).get(sessionId) === confirmed.returnFrom)
      && matchesSessionPlacement(sessions().get(instanceId)?.get(sessionId), capturedPlacement)
    const readSignal = signal ? AbortSignal.any([signal, authority.signal]) : authority.signal
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
        confirmSessionPlacement(instanceId, sessionId, result, confirmed.returnFrom)
        if (!matchesSessionPlacement(result, capturedPlacement) || result.listWorktreeSlug !== confirmed.placement.listWorktreeSlug || !matching) {
          applySessionMovePlacement(instanceId, { ...result, sessionID: sessionId })
          refreshSelectedMoveCatalog(instanceId, sessionId)
        }
        settleListedReturn(instanceId, sessionId)
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
    if (isSessionNotFoundError(error) && error.sessionID === sessionId) {
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

export function nativeSessionLifecycleGeneration(instanceId: string, sessionId: string): number {
  return nativeLifecycleGenerations.get(`${instanceId}\0${sessionId}`) ?? 0
}

function isCurrentNativeLifecycle(instanceId: string, sessionId: string, generation: number): boolean {
  return nativeSessionLifecycleGeneration(instanceId, sessionId) === generation
}

function dismissRetryToast(instanceId: string, sessionId: string): void {
  const backendId = parseInstanceKey(instanceId).backendId
  const active = activeRetryToasts.get(backendId)
  if (active?.key !== `${instanceId}\0${sessionId}`) return
  active.handle.dismiss()
  activeRetryToasts.delete(backendId)
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
  const authority = captureEventAuthority(instanceId)
  if (handlePruningEvent(instanceId, event)) return
  switch (event.type) {
    case "server.connected":
      reconcileInterruptedSessionMoves(instanceId)
      return
    case "form.created":
    case "form.replied":
    case "form.cancelled":
      return
    case "session.archived":
    case "session.unarchived":
      applySessionInfoDelta(instanceId, event.data.sessionID,
        { archive: { archived: event.type === "session.archived", at: event.created } })
      return
    case "session.renamed":
      applySessionInfoDelta(instanceId, event.data.sessionID, { title: { value: event.data.title, at: event.created } })
      return
    case "session.agent.selected":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      withSession(instanceId, event.data.sessionID, (session) => { session.agent = event.data.agent })
      return
    case "session.model.selected":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) {
        void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
          .then(() => authority.current() ? reconcileSessionModel(instanceId, event.data.sessionID) : undefined)
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
  const authority = captureEventAuthority(instanceId)
  const generation = advanceNativeLifecycle(instanceId, sessionId)
  // Claim this event before any refresh can expose its badge for acknowledgement.
  const current = sessions().get(instanceId)?.get(sessionId)
  if (current && options.interruptedAt !== undefined) observeSessionInterruption(instanceId, current, options.interruptedAt)
  let activeSessions: Record<string, unknown> | null = null
  try {
    if (!authority.current()) return
    activeSessions = await getRootClient(instanceId).session.active(authority.signal ? { signal: authority.signal } : undefined)
  } catch (error) {
    log.warn("Failed to reconcile terminal session state", { instanceId, sessionId, error })
  }
  if (!authority.current() || !isCurrentNativeLifecycle(instanceId, sessionId, generation)) return

  if (activeSessions && Object.prototype.hasOwnProperty.call(activeSessions, sessionId)) {
    withSession(instanceId, sessionId, (session) => { session.generationRecovery = null })
    if (!authority.current()) return
    const existing = sessions().get(instanceId)?.get(sessionId)
    if (existing) setSessionStatus(instanceId, sessionId, "working", { force: true })
    else ensureSessionStatus(instanceId, sessionId, "working", options.directory)
    return
  }

  if (options.interruptedAt !== undefined) {
    withSession(instanceId, sessionId, (session) => { session.generationRecovery = "interrupted" })
  }
  if (!authority.current()) return
  setTerminalNativeSessionStatus(instanceId, sessionId, options.failed, options.directory)
  if (!authority.current()) return
  refreshSettledSessionMessages(instanceId, sessionId, options.refreshMessages, options.failed)
  if (!authority.current()) return
  if (options.notify) notifySessionAttention("sessionDone", instanceId, sessionId)
}

function refreshSettledSessionMessages(instanceId: string, sessionId: string, force = false, failed = false): void {
  const signal = backendEvents.signalForInstance(instanceId)
  // The native reducer can reconcile its own cache after a missing tool terminal
  // event, but our bounded visible message store needs an authoritative load too.
  const store = messageStoreBus.getInstance(instanceId)
  const messageIds = store?.getSessionMessageIds(sessionId) ?? []
  const unsettledTools = messageIds.some(id => {
    const message = store?.getMessage(id)
    return message?.partIds.some(partId => {
      const part = message.parts[partId]?.data
      return part?.type === "tool" && (part.state?.status === "pending" || part.state?.status === "running")
    })
  })
  const lastMessage = messageIds.length ? store?.getMessage(messageIds[messageIds.length - 1]) : undefined
  const missingReply = !failed && Boolean(
    (activeSessionId().get(instanceId) === sessionId || isSessionTranscriptVisible(instanceId, sessionId))
    && isLatestWindow(store?.getMessageWindow(sessionId))
    && (store?.hasPendingSends(sessionId)
      || lastMessage?.role === "user"
      || (messagesLoaded().get(instanceId)?.has(sessionId) && messageIds.length === 0)),
  )
  if (force || unsettledTools || missingReply) {
    void loadMessages(instanceId, sessionId, { force: true, signal }).catch((error) => {
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
    if (session.location.directory === location.directory && session.location.workspaceID === location.workspaceID
      && session.projectID === projectID && session.subpath === subpath) return false
    session.location = location
    session.projectID = projectID
    session.subpath = subpath
  })
}

const movedSessionLists = new TrailingResyncCoordinator(async (instanceId, signal) => {
  const authority = captureEventAuthority(instanceId)
  if (!authority.current()) return
  await fetchSessions(instanceId, { reset: true, signal })
  if (!signal.aborted && authority.current() && activeSessionId().get(instanceId)) await refreshSessionCatalog(instanceId)
}, (instanceId, error) => log.warn("Failed to reconcile moved sessions", { instanceId, error }))

function refreshSelectedMoveCatalog(instanceId: string, sessionId: string): void {
  if (activeSessionId().get(instanceId) === sessionId) {
    void refreshSessionCatalog(instanceId).catch((error) => {
      log.warn("Failed to refresh moved session catalog", { instanceId, sessionId, error })
    })
  }
}

function handleSessionMoved(instanceId: string, data: SessionMoved["data"]): void {
  const authority = captureEventAuthority(instanceId)
  if (!authority.current()) return
  const { sessionID: sessionId, location } = data
  invalidateRestorePlacementRead(instanceId, sessionId)
  // The relay delivers each move to both owners in their own ordered streams.
  // Forwarding it here could supersede a later move in another instance.
  if (listsSessionDirectory(instanceId, location.directory)) {
    applySessionMovePlacement(instanceId, data)
    refreshSelectedMoveCatalog(instanceId, sessionId)
  }

  const move: SessionMove = { data, authority }
  clearPlacementEvidence(instanceId, sessionId)
  const latest = latestSessionMoves.get(instanceId) ?? new Map()
  latest.set(sessionId, move)
  latestSessionMoves.set(instanceId, latest)
  forgetSessionMovedAway(instanceId, sessionId)
  pendingSessionMoves.set(instanceId, (pendingSessionMoves.get(instanceId) ?? new Map()).set(sessionId, move))
  movedSessionRefreshTimers.get(instanceId)?.()
  const cancel = () => {
    clearTimeout(timer)
    authority.signal.removeEventListener("abort", cancel)
    if (movedSessionRefreshTimers.get(instanceId) === cancel) movedSessionRefreshTimers.delete(instanceId)
  }
  const timer = setTimeout(() => {
    if (movedSessionRefreshTimers.get(instanceId) !== cancel) return
    cancel()
    const moves = pendingSessionMoves.get(instanceId) ?? new Map<string, SessionMove>()
    pendingSessionMoves.delete(instanceId)
    if (!authority.current()) return
    const needsInventory = [...moves].some(([id, move]) => !move.data
      || !getSessionRoot(instanceId, id) || !listsSessionDirectory(instanceId, move.data.location.directory))
    void Promise.all([...moves].map(([movedId, move]) => settleSessionMove(instanceId, movedId, move)))
      .then(() => {
        if (needsInventory && authority.current()) return movedSessionLists.request(instanceId, authority.signal)
      })
  }, 100)
  movedSessionRefreshTimers.set(instanceId, cancel)
  authority.signal.addEventListener("abort", cancel, { once: true })
}

/** Re-admit only the IDs from this attachment, with an exact read under the new authority. */
export function reconcileInterruptedSessionMoves(instanceId: string): ReadonlySet<string> {
  const recovering = new Set<string>()
  const moves = latestSessionMoves.get(instanceId)
  const authority = captureEventAuthority(instanceId)
  if (!moves || !authority.current() || !instances().get(instanceId)?.client) return recovering
  for (const [id, previous] of moves) {
    if (previous.authority.signal !== authority.signal) continue
    let move = previous
    if (!previous.authority.current()) {
      move = { authority, unresolved: true }
      moves.set(id, move)
      pendingSessionMoves.get(instanceId)?.delete(id)
    }
    recovering.add(id)
    if (!move.data && move.unresolved) void settleSessionMove(instanceId, id, move)
  }
  if (pendingSessionMoves.get(instanceId)?.size === 0) {
    movedSessionRefreshTimers.get(instanceId)?.()
    pendingSessionMoves.delete(instanceId)
  }
  return recovering
}

async function settleSessionMove(instanceId: string, sessionId: string, move: SessionMove, fresh = false): Promise<boolean> {
  const { authority } = move
  const current = () => authority.current() && !!instances().get(instanceId)?.client
    && getPendingSessionMove(instanceId, sessionId) === move
  if (!current()) return false
  if (move.arrival) {
    const { session, evidenceCurrent } = move.arrival
    if (evidenceCurrent() && !sessions().get(instanceId)?.has(sessionId)) {
      return getWorktrees(instanceId).some(tree => tree.slug === session.listWorktreeSlug)
        && finishSessionMove(instanceId, sessionId, move, session, session)
    }
    // Another projection or proof arrived while waiting. Read its current owner.
    move.arrival = undefined
    move.data = undefined
  }
  const { data } = move
  const retry = move.unresolved
  move.unresolved = false
  if (data) {
    let inventoryKnown = fresh || (!retry && listsSessionDirectory(instanceId, data.location.directory))
    if (!inventoryKnown) {
      try {
        await reloadWorktrees(instanceId, true, authority.signal)
        inventoryKnown = true
      } catch (error) {
        log.warn("Failed to read the inventory for a moved session", { instanceId, sessionId, error })
      }
    }
    if (!current()) return false
    if (inventoryKnown && listsSessionDirectory(instanceId, data.location.directory)
      && (!getDirectoryOnlyWorktree(instanceId) || sessions().get(instanceId)?.has(sessionId))) {
      return finishSessionMove(instanceId, sessionId, move, data)
    }
  }
  // Containment alone cannot distinguish a registered checkout alias from a nested repo.
  const captured = sessions().get(instanceId)?.get(sessionId)
  const evidenceCurrent = captureSessionPlacementEvidence(instanceId, sessionId)
  try {
    const session = await readWorkspaceSessionPlacement(instanceId, sessionId, authority.signal)
    if (current() && (data || evidenceCurrent())) {
      const latest = sessions().get(instanceId)?.get(sessionId)
      if (session === LOCATED_ELSEWHERE || session === SESSION_MISSING) {
        if (data || latest === captured) return finishSessionMove(instanceId, sessionId, move, session)
      } else if (session?.id === sessionId && session.location && (latest || evidenceCurrent())) {
        if (data || latest === captured || (captured && matchesSessionPlacement(latest, captured))) {
          return finishSessionMove(instanceId, sessionId, move, session, session)
        }
      }
    }
  } catch (error) {
    if (current()) log.warn("Failed to confirm moved session placement", { instanceId, sessionId, error })
  }
  if (current()) move.unresolved = true
  return false
}

function finishSessionMove(instanceId: string, sessionId: string, move: SessionMove, placement: SessionPlacement | typeof LOCATED_ELSEWHERE | typeof SESSION_MISSING, verified?: SessionPlacementRead): boolean {
  if (getPendingSessionMove(instanceId, sessionId) !== move) return false
  if (!instances().has(instanceId) || getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) {
    clearPendingSessionMove(instanceId, sessionId)
    return false
  }
  const held = sessions().get(instanceId)?.get(sessionId)
  if (!held && verified?.listWorktreeSlug && !getWorktrees(instanceId).some(tree => tree.slug === verified.listWorktreeSlug)) {
    move.arrival = { session: verified, evidenceCurrent: captureSessionPlacementEvidence(instanceId, sessionId) }
    move.unresolved = false
    return false
  }
  clearPendingSessionMove(instanceId, sessionId)
  if (typeof placement !== "symbol") {
    if (verified) confirmSessionPlacement(instanceId, sessionId, placement)
    const listed = confirmedSessionListDirectory(instanceId, sessionId, placement)
    const inScope = listed || listsSessionDirectory(instanceId, placement.location.directory)
    const localDisplay = !!getDirectoryOnlyWorktree(instanceId) && inScope
    if (held) applySessionMovePlacement(instanceId, { ...placement, sessionID: sessionId })
    else if (verified && (localDisplay || listed
      || (!move.data && listsSessionDirectory(instanceId, placement.location.directory)))) {
      publishFetchedSessionInfo(instanceId, verified, undefined, move.authority.current)
    }
    if (inScope) {
      const root = getSessionRoot(instanceId, sessionId)
      if (root && !getSessionListIds(instanceId).includes(root.id)) prependSessionListId(instanceId, root.id)
    }
    if (!move.data && held) refreshSelectedMoveCatalog(instanceId, sessionId)
    return true
  }
  if (placement === LOCATED_ELSEWHERE) markSessionMovedAway(instanceId, sessionId, move.data?.location.directory ?? null)
  else excludeMissingMoveFromSearch(instanceId, sessionId)
  if (!sessions().get(instanceId)?.has(sessionId)) return true
  nativeLifecycleGenerations.delete(`${instanceId}\0${sessionId}`)
  dismissRetryToast(instanceId, sessionId)
  removeSessionProjection(instanceId, sessionId)
  return true
}

export function getPendingSessionMove(instanceId: string, sessionId: string): SessionMove | undefined {
  const move = latestSessionMoves.get(instanceId)?.get(sessionId)
  return move?.authority.current() ? move : undefined
}

export function clearPendingSessionMove(instanceId: string, sessionId?: string): void {
  clearPlacementEvidence(instanceId, sessionId)
  const moves = latestSessionMoves.get(instanceId)
  if (sessionId !== undefined) moves?.delete(sessionId)
  if (sessionId !== undefined) pendingSessionMoves.get(instanceId)?.delete(sessionId)
  if (sessionId === undefined || !moves?.size) latestSessionMoves.delete(instanceId)
  if (sessionId === undefined) {
    movedSessionRefreshTimers.get(instanceId)?.()
    pendingSessionMoves.delete(instanceId)
  }
}

export function isSessionMovePending(instanceId: string, sessionId: string): boolean {
  return getPendingSessionMove(instanceId, sessionId) !== undefined
}

export function settleListedReturn(instanceId: string, id: string): boolean {
  const evidence = placementEvidence().get(instanceId)?.get(id)
  if (evidence?.returnFrom === undefined || evidence.returnFrom !== getMovedAwaySessions(instanceId).get(id)
    || evidence.client !== instances().get(instanceId)?.client || evidence.generation !== getOpenCodeInstanceGeneration(instanceId)
    || isSessionMovePending(instanceId, id) || !matchesSessionPlacement(sessions().get(instanceId)?.get(id), evidence.placement)) return false
  const slug = evidence.placement.listWorktreeSlug
  if (slug === undefined ? !canRelistReturnedSession(instanceId, id)
    : !getWorktrees(instanceId).some(worktree => worktree.slug === slug)) return false
  confirmSessionPlacement(instanceId, id, evidence.placement)
  forgetSessionMovedAway(instanceId, id)
  return true
}

/** A later inventory that serves a moved-away session's destination lists it again. */
function relistReturnedSessions(instanceId: string): void {
  let returned = false
  for (const [id, directory] of getMovedAwaySessions(instanceId)) {
    if (hasPendingSessionReturn(instanceId, id)) {
      if (settleListedReturn(instanceId, id)) returned = true
    } else if (directory !== null && servesSessionDirectory(instanceId, directory)) {
      forgetSessionMovedAway(instanceId, id)
      returned = true
    }
  }
  if (!returned) return
  void movedSessionLists.request(instanceId, captureEventAuthority(instanceId).signal)
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

function getInstanceDisplayName(instanceId: string, detail?: string): string {
  const instance = instances().get(instanceId)
  const { backendId } = parseInstanceKey(instanceId)
  if (backendId === "local") {
    const folder = instance?.folder ?? instanceId
    return detail || folder.split(/[\\/]/).filter(Boolean).pop() || folder
  }
  const label = detail || (instance ? getInstanceLabel(instance) : instanceId)
  const server = uiState().remoteServers.find(profile => profile.id === backendId)?.name ?? backendId
  return tGlobal("sessionEvents.notify.serverTitle", { server, label })
}

/** Keep navigation and displayed notices on the exact event attachment. */
function showInstanceToast(instanceId: string, sessionId: string | undefined | null, payload: ToastPayload): ToastHandle {
  const local = parseInstanceKey(instanceId).backendId === "local"
  if (local && (!sessionId || payload.transient)) return showToastNotification(payload)
  const authority = captureEventAuthority(instanceId)
  const onClick = async () => {
    if (!authority.current()) return
    // An explicit open: show the conversation over any Mission reader, file or preview.
    const gesture = sessionId ? beginGesture({ instanceId, sessionId }) : undefined
    const { appTabs, selectAppTab } = await import("./app-tabs")
    if (!authority.current()) return
    const waiting = appTabs().find(tab => tab.kind === "remote-restore" && tab.instanceId === instanceId)
    if (waiting) { selectAppTab(waiting.id); return }
    // Only this window's tabs: another window's project is not ours to open.
    const tab = appTabs().find(tab => tab.kind === "instance" && tab.instance.id === instanceId)
    if (!tab) return
    if (sessionId && !sessions().get(instanceId)?.has(sessionId)) return
    selectAppTab(tab.id)
    if (sessionId && gesture) batch(() => {
      setActiveSessionFromList(instanceId, sessionId, gesture)
      applySurface({ instanceId, sessionId }, { kind: "conversation" }, gesture)
    })
  }
  if (local) return showToastNotification({ ...payload, systemAction: onClick })
  return showToastNotification({ ...payload, signal: authority.signal, action: {
    label: tGlobal(sessionId ? "interruption.viewConversation" : "folderSelection.recent.switchToOpenProject"),
    onClick,
  } })
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
  showInstanceToast(instanceId, sessionId, { category, title: getInstanceDisplayName(instanceId), message, variant: "info" })
}

queueMicrotask(() => {
  onWorktreesPublished((instanceId, fresh) => {
    const authority = captureEventAuthority(instanceId)
    if (!authority.current()) return
    reconcileInterruptedSessionMoves(instanceId)
    relistReturnedSessions(instanceId)
    const retries: Promise<boolean>[] = []
    for (const [sessionId, move] of latestSessionMoves.get(instanceId) ?? []) {
      if (!move.arrival && (!move.data || !move.unresolved)) continue
      retries.push(settleSessionMove(instanceId, sessionId, move, fresh))
    }
    if (retries.length) void Promise.all(retries).then(results => {
      if (results.some(Boolean) && authority.current()) return movedSessionLists.request(instanceId, authority.signal)
    })
  })
  setPendingFormAddedHandler((instanceId, form) => notifySessionAttention("needsInput", instanceId, form.sessionID))
})

const ALLOWED_TOAST_VARIANTS = new Set<ToastVariant>(["info", "success", "warning", "error"])

/** Whether the project is still open on the OpenCode data generation captured earlier. */
function isInstanceGenerationCurrent(instanceId: string, generation: number): boolean {
  return instances().has(instanceId) && getOpenCodeInstanceGeneration(instanceId) === generation
}

function applyArchiveDelta(time: Session["time"], delta: NonNullable<SessionInfoObservation["archive"]>): Session["time"] {
  const { archived: _archived, ...rest } = time
  return { ...rest, updated: Math.max(time.updated, delta.at), ...(delta.archived ? { archived: delta.at } : {}) }
}

/** Keep events that join cold hydration, including after a list page installs the row. */
function applySessionInfoDelta(instanceId: string, sessionId: string, delta: SessionInfoDelta): void {
  const existing = sessions().get(instanceId)?.get(sessionId)
  if (!existing) {
    void fetchSessionInfo(instanceId, sessionId, undefined, delta)
    return
  }
  const held = sessionInfoReads.get(`${instanceId}\0${sessionId}`)
  const metadata = held?.current() ? held.metadata : undefined
  const snapshotAt = observedSessionInfoTime(existing, metadata)
  if (metadata) {
    Object.assign(metadata, delta)
    if (snapshotAt > (delta.title?.at ?? delta.archive!.at)) return
  }
  if (delta.title) {
    const { value } = delta.title
    if (existing.title !== value) withSession(instanceId, sessionId, session => { session.title = value })
  } else {
    const time = applyArchiveDelta(existing.time, delta.archive)
    withSession(instanceId, sessionId, session => { session.time = time })
    if (metadata) {
      metadata.projectedArchive = { time: sessions().get(instanceId)!.get(sessionId)!.time, snapshotAt }
    }
  }
}

function observedSessionInfoTime(row: Session | undefined, metadata: SessionInfoObservation | undefined): number {
  if (!row) return 0
  const projected = metadata?.projectedArchive
  return projected && projected.time === row.time ? projected.snapshotAt : row.time.updated
}

function fetchSessionInfo(instanceId: string, sessionId: string, directory?: string, metadata: SessionInfoObservation = {}): Promise<Session | null> {
  const authority = captureEventAuthority(instanceId)
  const instance = instances().get(instanceId)
  if (!instance?.client || !authority.current()
    || getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) return Promise.resolve(null)
  const key = `${instanceId}\0${sessionId}`
  const held = sessionInfoReads.get(key)
  if (held?.signal === authority.signal && held.current()) {
    Object.assign(held.metadata, metadata)
    return held.result
  }

  void directory
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const current = () => authority.current() && isInstanceGenerationCurrent(instanceId, generation)
  const captured = sessions().get(instanceId)?.get(sessionId)
  const observation = { ...authority, current, metadata, result: Promise.resolve<Session | null>(null) }
  const result = (async () => {
    try {
      const info = await getRootClient(instanceId).session.get({ sessionID: sessionId }, { signal: authority.signal })
      // A project closed or a client replaced during the read publishes nothing.
      if (info.id !== sessionId || !current()) return null
      return publishFetchedSessionInfo(instanceId, info, captured, current, metadata)
    } catch (error) {
      if (authority.current()) log.error("Failed to fetch session info", error)
      return null
    }
  })().finally(() => {
    if (sessionInfoReads.get(key)?.result === result) sessionInfoReads.delete(key)
  })
  observation.result = result
  sessionInfoReads.set(key, observation)
  return result
}

function publishFetchedSessionInfo(instanceId: string, info: SessionInfo, captured: Session | undefined, current = captureEventAuthority(instanceId).current, metadata?: SessionInfoObservation): Session | null {
  if (!current()) return null
  const sessionId = info.id
  const fetched = createClientSession(info, instanceId)
  let publishedRoot = false

  setSessions((prev) => {
    const existing = prev.get(instanceId)?.get(sessionId)
    const compacting = existing?.status === "compacting"
    const candidate: Session = {
      ...fetched,
      agent: existing?.agent ?? fetched.agent,
      model: existing?.model ?? fetched.model,
      status: compacting ? "compacting" : fetched.status,
      retry: compacting ? null : fetched.retry,
      idleSince: getIdleSinceForStatusTransition(existing?.status, compacting ? "compacting" : fetched.status, existing?.idleSince),
      ...getSessionPendingIndicators(instanceId, sessionId),
      runtimeStatusKnown: compacting || existing?.runtimeStatusKnown || false,
    }
    const merged = mergeFetchedSessionRuntimeState(
      candidate,
      captured,
      existing,
      getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId),
    )
    if (merged && metadata) {
      // A list page may have installed a row during the point read. Reapply
      // each event field against its own timestamp, independent of other deltas.
      const existingAt = observedSessionInfoTime(existing, metadata)
      const pointAt = fetched.time.updated
      const newest = existing && existingAt >= pointAt ? existing : fetched
      const newestAt = Math.max(existingAt, pointAt)
      if (metadata.title) merged.title = newestAt > metadata.title.at ? newest.title : metadata.title.value
      if (metadata.archive) {
        if (newestAt <= metadata.archive.at) {
          merged.time = applyArchiveDelta(merged.time, metadata.archive)
        } else if (newest.time !== merged.time) {
          const { archived: _archived, ...time } = merged.time
          merged.time = { ...time, updated: Math.max(time.updated, newestAt),
            ...(newest.time.archived === undefined ? {} : { archived: newest.time.archived }) }
        }
      }
    }
    publishedRoot = merged?.parentId === null
    return merged ? replaceSessionRow(prev, instanceId, merged) : prev
  })

  if (!current()) return null
  if (publishedRoot) prependSessionListId(instanceId, sessionId)

  return fetched
}

function ensureSessionStatus(
  instanceId: string,
  sessionId: string,
  status: SessionStatus,
  directory?: string,
  retry?: SessionRetryState | null,
): Promise<void> {
  const authority = captureEventAuthority(instanceId)
  if (!authority.current()) return Promise.resolve()
  const existing = sessions().get(instanceId)?.get(sessionId)
  if (existing) {
    setSessionStatus(instanceId, sessionId, status, { retry })
    return Promise.resolve()
  }

  // Reads coalesce within one instance generation: a replaced client reads again.
  const lifecycle = nativeSessionLifecycleGeneration(instanceId, sessionId)
  const key = `${instanceId}:${getOpenCodeInstanceGeneration(instanceId)}:${sessionId}`
  const existingFetch = pendingSessionFetches.get(key)
  if (existingFetch?.current() && existingFetch.signal === authority.signal) {
    existingFetch.status = status
    existingFetch.retry = retry
    existingFetch.lifecycle = lifecycle
    return existingFetch.settled
  }

  const pendingState = { status, retry, lifecycle, settled: Promise.resolve(), signal: authority.signal, current: authority.current }
  const pending = (async () => {
    const fetched = await fetchSessionInfo(instanceId, sessionId, directory)
    if (!fetched || !authority.current() || !isCurrentNativeLifecycle(instanceId, sessionId, pendingState.lifecycle)) return
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
      ...getSessionPendingIndicators(instanceId, info.id),
      time: info.time
        ? { ...info.time }
        : {
            created: Date.now(),
            updated: Date.now(),
          },
    } as Session

    setSessions(previous => replaceSessionRow(previous, instanceId, newSession))

    if (!newSession.parentId) {
      prependSessionListId(instanceId, newSession.id)
    }

    log.info(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    withSession(instanceId, existingSession.id, session => {
      session.title = info.title || session.title
      session.parentId = info.parentID ?? session.parentId
      session.metadata = info.metadata ?? session.metadata
      session.status ??= "idle"
      session.retry ??= null
      session.time = { ...session.time, ...info.time }
    })
  }
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
  const authority = captureEventAuthority(instanceId)
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
    if (authority.current() && isInstanceGenerationCurrent(instanceId, instanceGeneration) && sessions().get(instanceId)?.has(sessionId)
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
  const backendId = parseInstanceKey(instanceId).backendId
  activeRetryToasts.get(backendId)?.handle.dismiss()
  // A live retry status replaced by the next attempt, not an event to keep.
  activeRetryToasts.set(backendId, { key: `${instanceId}\0${sessionId}`, handle: showInstanceToast(instanceId, sessionId, { category: "sessions", transient: true,
    title: getInstanceDisplayName(instanceId, label),
    message: tGlobal("sessionList.status.retryToast", {
      countdown,
      message: retry.message,
      attempt: String(retry.attempt),
    }),
    variant: "error",
    duration: 7000,
  }) })
}

function handleSessionCompacted(instanceId: string, event: SessionCompactionEnded): void {
  const authority = captureEventAuthority(instanceId)
  const sessionID = event.data.sessionID
  if (!sessionID) return

  log.info(`[SSE] Session compacted: ${sessionID}`)
  advanceNativeLifecycle(instanceId, sessionID)

  const existing = sessions().get(instanceId)?.get(sessionID)
  if (existing) {
    setSessionStatus(instanceId, sessionID, "working", { force: true })
    if (authority.current()) announceCompaction(instanceId, event)
  } else {
    // An unknown session's scope is known once its metadata is read and
    // published; a failed read, a deletion or a closed project announces nothing.
    const instanceGeneration = getOpenCodeInstanceGeneration(instanceId)
    void ensureSessionStatus(instanceId, sessionID, "working", event.location?.directory).then(() => {
      if (authority.current() && isInstanceGenerationCurrent(instanceId, instanceGeneration) && sessions().get(instanceId)?.has(sessionID)) announceCompaction(instanceId, event)
    })
  }
}

function announceCompaction(instanceId: string, event: SessionCompactionEnded): void {
  const sessionID = event.data.sessionID
  if (isReservedMissionScheduleSessionID(sessionID)) return
  // Announced by the project whose list shows the session, not by an owning parent.
  if (sessions().get(instanceId)?.has(sessionID) && !isSessionInWorkspaceScope(instanceId, sessionID)) return
  const { backendId } = parseInstanceKey(instanceId)
  if (!claimCompactionNotice(event, backendId)) return
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionID)
  const label = session?.title?.trim() ? session.title : sessionID
  const instanceName = getInstanceDisplayName(instanceId)
  const displayLabel = label ? `"${label}"` : sessionID

  compactionBubbles.show(`${backendId}\0${sessionID}`, COMPACTION_TOAST_MS, () => showInstanceToast(instanceId, sessionID, { category: "sessions",
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

function handleTuiToast(instanceId: string, event: TuiToastShow): void {
  const payload = event.data
  if (!payload || typeof payload.message !== "string" || typeof payload.variant !== "string") return
  if (!payload.message.trim()) return

  const variant: ToastVariant = ALLOWED_TOAST_VARIANTS.has(payload.variant as ToastVariant)
    ? (payload.variant as ToastVariant)
    : "info"

  showInstanceToast(instanceId, undefined, { category: "opencode",
    title: parseInstanceKey(instanceId).backendId === "local"
      ? typeof payload.title === "string" ? payload.title : undefined
      : getInstanceDisplayName(instanceId, typeof payload.title === "string" ? payload.title : undefined),
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
