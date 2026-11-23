import { batch } from "solid-js"
import { $RAW, createStore, produce, reconcile, unwrap } from "solid-js/store"
import type { SetStoreFunction } from "solid-js/store"
import { getLogger } from "../../lib/logger"
import { getCacheRetainedEntriesForSession } from "../../lib/global-cache"
import {
  clearPromptDisplayOverride,
  clearPromptDisplayOverridesForInstance,
  clearPromptDisplayOverridesForSession,
  getPromptDisplayOverride,
  movePromptDisplayOverride,
  setPromptDisplayOverride,
} from "../message-prompt-display"
import type { ClientPart, MessageInfo } from "../../types/message"
import { mergePermissionRequest } from "../../types/permission"
import { clearRecordDisplayCacheForInstance, clearRecordDisplayCacheForMessages, getRecordDisplayCacheEntries } from "./record-display-cache"
import { estimateRetainedBytesIncrementally } from "../../lib/retained-size"
import { clearInstanceMessageRenderCaches, clearSessionMessageRenderCache, peekSessionMessageRenderCache } from "../../lib/message-render-cache"
import type { MessageWindowState } from "./message-window"
import { shouldSkipPendingRequestUpsert } from "./pending-request-dedupe"
import type {
  InstanceMessageState,
  LatestTodoSnapshot,
  MessageRecord,
  MessageUpsertInput,
  PermissionEntry,
  ReplaceMessageIdOptions,
  ScrollSnapshot,
  SessionRecord,
  SessionUpsertInput,
  SessionUsageState,
  UsageEntry,
} from "./types"

const storeLog = getLogger("session")

interface MessageStoreHooks {
  onSessionCleared?: (instanceId: string, sessionId: string) => void
  onSessionChanged?: (instanceId: string, sessionId: string) => void
  onMessagesRemoved?: (instanceId: string, sessionId: string, messageIds: readonly string[]) => void
  onScrollSnapshotChanged?: (instanceId: string, sessionId: string, scope: string, snapshot: ScrollSnapshot) => void
}

function createInitialState(instanceId: string): InstanceMessageState {
  return {
    instanceId,
    sessions: {},
    sessionOrder: [],
    messages: {},
    lastAssistantMessageIds: {},
    messageInfoVersion: {},
    sessionRevisions: {},
    permissions: {
      queue: [],
      active: null,
      byMessage: {},
    },
    usage: {},
    scrollState: {},
    latestTodos: {},
  }
}

function ensurePartId(messageId: string, part: ClientPart, index: number): string {
  if (typeof part.id === "string" && part.id.length > 0) {
    return part.id
  }

  if (part.type === "tool") {
    throw new Error("Tool part missing id")
  }

  const fallbackId = `${messageId}-part-${index}`
  part.id = fallbackId
  return fallbackId
}

const MAX_TRANSCRIPT_MEASUREMENT_BYTES = 64 * 1024 * 1024
const MAX_TRANSCRIPT_MEASUREMENT_NODES = 500_000

/** Rows a chunked hydration commits before yielding the main thread. */
export const HYDRATE_CHUNK_SIZE = 50

/** Yields to the main thread between chunk commits: `scheduler.yield` where
 * available, otherwise a macrotask boundary (a microtask would not let input,
 * timers or paint run between chunks). */
function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler && typeof scheduler.yield === "function") return scheduler.yield()
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function clonePart(part: ClientPart): ClientPart {
  // Cloning is intentionally disabled; message parts
  // are stored as received from the backend.
  return part
}

function areMessageIdListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) {
      return false
    }
  }
  return true
}

function createEmptyUsageState(): SessionUsageState {
  return {
    entries: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCost: 0,
    actualUsageTokens: 0,
    latestMessageId: undefined,
  }
}

function resolveClientPromptDisplayText(
  instanceId: string,
  input: Pick<MessageUpsertInput, "id" | "sessionId" | "clientPromptDisplayMetadata">,
  previous?: Pick<MessageRecord, "clientPromptDisplayMetadata">,
) {
  if (input.clientPromptDisplayMetadata) {
    return input.clientPromptDisplayMetadata
  }

  const persisted = getPromptDisplayOverride(instanceId, input.sessionId, input.id)
  if (persisted) {
    return persisted
  }

  return previous?.clientPromptDisplayMetadata
}

// Structural equality without serializing: the per-event window comparison
// walks every part of every resident message, so it must not allocate
// throwaway strings (JSON.stringify) on the unchanged common path.
function partDataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) {
      if (!partDataEqual(a[index], b[index])) return false
    }
    return true
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!partDataEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

function messageInfoEqual(a: MessageInfo, b: MessageInfo): boolean {
  return partDataEqual(a, b)
}

function samePromptDisplayMetadata(
  next: MessageRecord["clientPromptDisplayMetadata"],
  previous: MessageRecord["clientPromptDisplayMetadata"],
): boolean {
  if (next === previous) return true
  if (!next || !previous) return false
  return JSON.stringify(next) === JSON.stringify(previous)
}

function extractUsageEntry(info: MessageInfo | undefined): UsageEntry | null {
  if (!info || info.role !== "assistant") return null
  const messageId = typeof info.id === "string" ? info.id : undefined
  if (!messageId) return null
  const tokens = info.tokens
  if (!tokens) return null
  const inputTokens = tokens.input ?? 0
  const outputTokens = tokens.output ?? 0
  const reasoningTokens = tokens.reasoning ?? 0
  const cacheReadTokens = tokens.cache?.read ?? 0
  const cacheWriteTokens = tokens.cache?.write ?? 0
  if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
    return null
  }
  const combinedTokens = info.summary ? outputTokens : inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens
  return {
    messageId,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    combinedTokens,
    cost: info.cost ?? 0,
    timestamp: info.time?.created ?? 0,
    hasContextUsage: inputTokens + cacheReadTokens + cacheWriteTokens > 0,
  }
}

function applyUsageState(state: SessionUsageState, entry: UsageEntry | null) {
  if (!entry) return
  state.entries[entry.messageId] = entry
  state.totalInputTokens += entry.inputTokens
  state.totalOutputTokens += entry.outputTokens
  state.totalReasoningTokens += entry.reasoningTokens
  state.totalCost += entry.cost
  if (!state.latestMessageId || entry.timestamp >= (state.entries[state.latestMessageId]?.timestamp ?? 0)) {
    state.latestMessageId = entry.messageId
    state.actualUsageTokens = entry.combinedTokens
  }
}

function removeUsageEntry(state: SessionUsageState, messageId: string | undefined) {
  if (!messageId) return
  const existing = state.entries[messageId]
  if (!existing) return
  state.totalInputTokens -= existing.inputTokens
  state.totalOutputTokens -= existing.outputTokens
  state.totalReasoningTokens -= existing.reasoningTokens
  state.totalCost -= existing.cost
  delete state.entries[messageId]
  if (state.latestMessageId === messageId) {
    state.latestMessageId = undefined
    state.actualUsageTokens = 0
    let latest: UsageEntry | null = null
    for (const candidate of Object.values(state.entries) as UsageEntry[]) {
      if (!latest || candidate.timestamp >= latest.timestamp) {
        latest = candidate
      }
    }
    if (latest) {
      state.latestMessageId = latest.messageId
      state.actualUsageTokens = latest.combinedTokens
    }
  }
}

function rebuildUsageStateFromInfos(infos: Iterable<MessageInfo>): SessionUsageState {
  const usageState = createEmptyUsageState()
  for (const info of infos) {
    const entry = extractUsageEntry(info)
    if (entry) {
      applyUsageState(usageState, entry)
    }
  }
  return usageState
}

export interface InstanceMessageStore {
  instanceId: string
  state: InstanceMessageState
  setState: SetStoreFunction<InstanceMessageState>
  addOrUpdateSession: (input: SessionUpsertInput) => void
  hydrateMessages: (sessionId: string, inputs: MessageUpsertInput[], infos?: Iterable<MessageInfo>, options?: { preserveOmitted?: boolean; confirmPending?: boolean; chunked?: boolean; guard?: () => boolean; keepStreamedArrivals?: boolean }) => void | Promise<boolean>
  reconcileEmptyAuthoritativeSnapshot: (sessionId: string) => void
  reconcileAuthoritativeMessageIds: (sessionId: string, authoritativeIds: ReadonlySet<string>, baselineRevisions: ReadonlyMap<string, number>) => void
  markSendPending: (messageId: string) => void
  acceptSend: (messageId: string) => void
  failSend: (messageId: string) => void
  failPendingSends: (sessionId: string) => void
  retirePendingSends: (sessionId: string) => void
  upsertMessage: (input: MessageUpsertInput) => void
  removeMessage: (messageId: string, fallbackSessionId?: string) => void
  removeMessagePart: (messageId: string, partId: string, fallbackSessionId?: string) => void
  replaceMessageId: (options: ReplaceMessageIdOptions) => void
  setMessageInfo: (messageId: string, info: MessageInfo) => void
  getMessageInfo: (messageId: string) => MessageInfo | undefined
  upsertPermission: (entry: PermissionEntry) => void
  removePermission: (permissionId: string) => void
  getPermissionState: (messageId?: string, partId?: string) => { entry: PermissionEntry; active: boolean } | null
  setSessionRevert: (sessionId: string, revert?: SessionRecord["revert"] | null) => void
  getSessionRevert: (sessionId: string) => SessionRecord["revert"] | undefined | null
  rebuildUsage: (sessionId: string, infos: Iterable<MessageInfo>) => void
  getSessionUsage: (sessionId: string) => SessionUsageState | undefined
  setScrollSnapshot: (sessionId: string, scope: string, snapshot: Omit<ScrollSnapshot, "updatedAt">) => void
  restoreScrollSnapshot: (sessionId: string, scope: string, snapshot: ScrollSnapshot) => void
  getScrollSnapshot: (sessionId: string, scope: string) => ScrollSnapshot | undefined
  setMessageWindow: (sessionId: string, window: MessageWindowState) => void
  getMessageWindow: (sessionId: string) => MessageWindowState | undefined
  getSessionRevision: (sessionId: string) => number
  getSessionMessageIds: (sessionId: string) => string[]
  getLastAssistantMessageId: (sessionId: string) => string | undefined
  // Index of the most recent message in the session that contains a compaction part.
  // Returns -1 if there has been no compaction.
  getLastCompactionMessageIndex: (sessionId: string) => number
  getMessage: (messageId: string) => MessageRecord | undefined
  getLatestTodoSnapshot: (sessionId: string) => LatestTodoSnapshot | undefined
  hasPendingSends: (sessionId: string) => boolean
  trimSessionMessages: (sessionId: string, limit: number) => void
  estimateSessionRetainedBytes: (sessionId: string, signal?: AbortSignal) => Promise<number>
  hasLiveSessionMessages: (sessionId: string) => boolean
  evictSessionTranscript: (sessionId: string) => void
  clearSession: (sessionId: string, options?: { preserveScroll?: boolean; preservePromptDisplayOverrides?: boolean; notify?: boolean }) => void
  clearScrollSnapshots: () => void
  clearInstance: () => void
}

export function createInstanceMessageStore(instanceId: string, hooks?: MessageStoreHooks): InstanceMessageStore {
  const [state, setState] = createStore<InstanceMessageState>(createInitialState(instanceId))

  const TODO_TOOL_NAME = "todowrite"

  const messageInfoCache = new Map<string, MessageInfo>()

  // Requests awaiting same-ID persistence confirmation.
  const pendingSendIds = new Set<string>()

  // Fence tokens for chunked hydrations: a chunked hydration commits across
  // task boundaries, so every other write to the session bumps its token and
  // the stale snapshot stops committing (the newest writer owns the session).
  const hydrationFences = new Map<string, number>()

  function fenceSessionHydration(sessionId: string): void {
    if (!sessionId) return
    hydrationFences.set(sessionId, (hydrationFences.get(sessionId) ?? 0) + 1)
  }

  function currentHydrationFence(sessionId: string): number {
    return hydrationFences.get(sessionId) ?? 0
  }

  function forgetPendingSend(messageId: string): void {
    pendingSendIds.delete(messageId)
  }

  function preservePendingSendOnOmission(messageId: string): boolean {
    return pendingSendIds.has(messageId)
  }

  function findLastAssistantMessageId(messageIds: readonly string[]): string | undefined {
    for (let index = messageIds.length - 1; index >= 0; index -= 1) {
      const messageId = messageIds[index]
      if (state.messages[messageId]?.role === "assistant") {
        return messageId
      }
    }
    return undefined
  }

  function recomputeLastAssistantMessageId(sessionId: string, messageIds?: readonly string[]) {
    if (!sessionId) return
    setState("lastAssistantMessageIds", sessionId, findLastAssistantMessageId(messageIds ?? state.sessions[sessionId]?.messageIds ?? []))
  }

  function getLastCompactionMessageIndex(sessionId: string): number {
    if (!sessionId) return -1
    const ids = state.sessions[sessionId]?.messageIds ?? []
    // Scan from the end: we only care about the most recent compaction.
    for (let i = ids.length - 1; i >= 0; i--) {
      const messageId = ids[i]
      const record = state.messages[messageId]
      if (!record || !Array.isArray(record.partIds) || record.partIds.length === 0) continue
      for (const partId of record.partIds) {
        const part = record.parts[partId]?.data
        if ((part as any)?.type === "compaction") {
          return i
        }
      }
    }
    return -1
  }

  function isCompletedTodoPart(part: ClientPart | undefined): boolean {
    if (!part || (part as any).type !== "tool") {
      return false
    }
    const toolName = typeof (part as any).tool === "string" ? (part as any).tool : ""
    if (toolName !== TODO_TOOL_NAME) {
      return false
    }
    const toolState = (part as any).state
    if (!toolState || typeof toolState !== "object") {
      return false
    }
    return (toolState as { status?: string }).status === "completed"
  }

  function recordLatestTodoSnapshot(sessionId: string, snapshot: LatestTodoSnapshot) {
    if (!sessionId) return
    setState("latestTodos", sessionId, (existing) => {
      if (existing && existing.timestamp > snapshot.timestamp) {
        return existing
      }
      return snapshot
    })
  }

  function maybeUpdateLatestTodoFromRecord(record: MessageRecord | undefined) {
    if (!record || !Array.isArray(record.partIds) || record.partIds.length === 0) {
      return
    }
    for (let index = record.partIds.length - 1; index >= 0; index -= 1) {
      const partId = record.partIds[index]
      const partRecord = record.parts[partId]
      if (!partRecord) continue
      if (isCompletedTodoPart(partRecord.data)) {
        const timestamp = typeof record.updatedAt === "number" ? record.updatedAt : Date.now()
        recordLatestTodoSnapshot(record.sessionId, { messageId: record.id, partId, timestamp })
        break
      }
    }
  }

  function clearLatestTodoSnapshot(sessionId: string) {
    setState("latestTodos", sessionId, undefined)
  }

  function getLatestTodoSnapshot(sessionId: string): LatestTodoSnapshot | undefined {
    const snapshot = state.latestTodos[sessionId]
    if (!snapshot) return undefined
    const messageIds = state.sessions[sessionId]?.messageIds ?? []
    return messageIds.indexOf(snapshot.messageId) > getLastCompactionMessageIndex(sessionId) ? snapshot : undefined
  }

  function bumpSessionRevision(sessionId: string) {
    if (!sessionId) return
    setState("sessionRevisions", sessionId, (value = 0) => value + 1)
    hooks?.onSessionChanged?.(instanceId, sessionId)
  }

  function getSessionRevisionValue(sessionId: string) {
    return state.sessionRevisions[sessionId] ?? 0
  }

  function getLastAssistantMessageIdValue(sessionId: string) {
    return state.lastAssistantMessageIds[sessionId]
  }

  function withUsageState(sessionId: string, updater: (draft: SessionUsageState) => void) {
    setState("usage", sessionId, (current) => {
      const draft = current
        ? {
            ...current,
            entries: { ...current.entries },
          }
        : createEmptyUsageState()
      updater(draft)
      return draft
    })
  }

  function updateUsageWithInfo(info: MessageInfo | undefined) {
    if (!info || typeof info.sessionID !== "string") return
    const messageId = typeof info.id === "string" ? info.id : undefined
    if (!messageId) return
    withUsageState(info.sessionID, (draft) => {
      removeUsageEntry(draft, messageId)
      const entry = extractUsageEntry(info)
      if (entry) {
        applyUsageState(draft, entry)
      }
    })
  }

  function rebuildUsage(sessionId: string, infos: Iterable<MessageInfo>) {
    const usageState = rebuildUsageStateFromInfos(infos)
    setState("usage", sessionId, usageState)
  }

  function getSessionUsage(sessionId: string) {
    return state.usage[sessionId]
  }

  function hasLiveSessionMessages(sessionId: string): boolean {
    for (const messageId of state.sessions[sessionId]?.messageIds ?? []) {
      const message = state.messages[messageId]
      if (pendingSendIds.has(messageId) || message?.status === "sending" || message?.status === "streaming") return true
    }
    return false
  }

  function hasPendingSends(sessionId: string): boolean {
    for (const messageId of pendingSendIds) {
      if (state.messages[messageId]?.sessionId === sessionId) return true
    }
    return false
  }

  function estimateSessionRetainedBytes(sessionId: string, signal?: AbortSignal): Promise<number> {
    const session = state.sessions[sessionId]
    const renderCache = peekSessionMessageRenderCache(instanceId, sessionId)
    const globalCacheEntries = [...getCacheRetainedEntriesForSession(instanceId, sessionId)]
    const globalCacheKeyBytes = globalCacheEntries.reduce((total, entry) => total + entry.keyBytes, 0)
    if ((!session || (session.messageIds.length === 0 && !session.revert)) && !renderCache && globalCacheEntries.length === 0) {
      return Promise.resolve(0)
    }
    // Walk the store's raw data: unwrap() on a store proxy returns the
    // underlying target through its $RAW fast path, so the byte estimate does
    // not pay Solid's per-access proxy traps for every field of every resident
    // record — a proxied pass over one long-context transcript cost seconds of
    // main-thread time, and the measurement runs after every session revision
    // change (open, hydrate, delete).
    const rawSession = session ? unwrap(session) : undefined
    const rawMessages = unwrap(state.messages)
    const rawMessageInfoVersion = unwrap(state.messageInfoVersion)
    const rawPermissions = unwrap(state.permissions)
    const rawUsage = unwrap(state.usage)
    const rawSessionRevisions = unwrap(state.sessionRevisions)
    const rawLastAssistantMessageIds = unwrap(state.lastAssistantMessageIds)
    const rawLatestTodos = unwrap(state.latestTodos)
    function* retainedValues(): Generator<unknown> {
      if (rawSession) yield rawSession
      for (const messageId of rawSession?.messageIds ?? []) {
        yield rawMessages[messageId]
        yield messageInfoCache.get(messageId)
        yield rawMessageInfoVersion[messageId]
      }
      for (const entry of rawPermissions.queue) if (entry.permission.sessionID === sessionId) yield entry
      if (rawSession) {
        yield rawUsage[sessionId]
        yield rawSessionRevisions[sessionId]
        yield rawLastAssistantMessageIds[sessionId]
        yield rawLatestTodos[sessionId]
      }
      yield renderCache
      if (rawSession) yield* getRecordDisplayCacheEntries(instanceId, rawSession.messageIds)
      for (const entry of globalCacheEntries) yield entry.value
    }
    if (globalCacheKeyBytes > MAX_TRANSCRIPT_MEASUREMENT_BYTES) return Promise.resolve(Number.POSITIVE_INFINITY)
    return estimateRetainedBytesIncrementally(retainedValues(), {
      signal,
      rootIterable: true,
      // Display and global caches reference record data through store
      // proxies; canonicalizing every visited object to its raw target keeps
      // the identity-based deduplication from counting those aliases twice.
      canonicalize: (value: object) => (value as Record<symbol, object>)[$RAW] ?? value,
      maxBytes: MAX_TRANSCRIPT_MEASUREMENT_BYTES - globalCacheKeyBytes,
      maxNodes: MAX_TRANSCRIPT_MEASUREMENT_NODES,
    }).then((bytes) => Number.isFinite(bytes) ? bytes + globalCacheKeyBytes : bytes)
  }

  function ensureSessionEntry(sessionId: string): SessionRecord {
    const existing = state.sessions[sessionId]
    if (existing) {
      return existing
    }

    const now = Date.now()
    const session: SessionRecord = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      messageIds: [],
    }

    setState("sessions", sessionId, session)
    setState("sessionOrder", (order) => (order.includes(sessionId) ? order : [...order, sessionId]))
    return session
  }

  function addOrUpdateSession(input: SessionUpsertInput) {
    const session = ensureSessionEntry(input.id)
    const previousIds = [...session.messageIds]
    const nextMessageIds = Array.isArray(input.messageIds) ? input.messageIds : session.messageIds

    setState("sessions", input.id, {
      ...session,
      title: input.title ?? session.title,
      parentId: input.parentId ?? session.parentId ?? null,
      updatedAt: Date.now(),
      messageIds: nextMessageIds,
      revert: input.revert !== undefined ? input.revert : session.revert ?? null,
    })

    if (Array.isArray(input.messageIds) && !areMessageIdListsEqual(previousIds, nextMessageIds)) {
      recomputeLastAssistantMessageId(input.id, nextMessageIds)
      bumpSessionRevision(input.id)
    }
  }

  // Compares incoming parts against the previously stored parts for a message.
  // Used by hydrateMessages (full reload / force refresh) to avoid bumping
  // revision -- and therefore invalidating downstream render caches -- for
  // messages whose content is byte-identical to what's already in the store.
  // Cheap: parts are small (text chunks, tool state); JSON.stringify is fine
  // here versus the cost of a full re-render of every message in the session.
  function havePartsChanged(
    previousPartIds: string[] | undefined,
    previousParts: MessageRecord["parts"] | undefined,
    nextIds: string[],
    nextMap: MessageRecord["parts"],
  ): boolean {
    if (!previousPartIds || !previousParts) return true
    if (previousPartIds.length !== nextIds.length) return true
    for (let i = 0; i < nextIds.length; i++) {
      if (previousPartIds[i] !== nextIds[i]) return true
    }
    for (const id of nextIds) {
      const prevPart = previousParts[id]
      const nextPart = nextMap[id]
      if (prevPart === nextPart) continue
      if (!prevPart || !nextPart) return true
      if (!partDataEqual(prevPart.data, nextPart.data)) return true
    }
    return false
  }

  // NOTE: optimistic sends are reconciled purely by IDENTITY. The client
  // serializes its optimistic id as `messageID` on the prompt request, so a
  // confirmed send always reappears under the SAME id and is updated in place
  // by the normal hydrate/upsert paths. There is intentionally no
  // content-signature fallback: guessing ownership from identical text could
  // delete an unrelated local send (or an identical prompt from another
  // client) and cross-attach its metadata. Sends the server has not yet
  // echoed are preserved via `pendingSendIds` instead (see hydrateMessages).

  interface HydrationPlan {
    revertMessageId: string | undefined
    /** Resident records at plan time: the diff basis every chunk compares
     * against, so a row the store has since replaced is decided by content
     * freshness at the finalize pass, not by whichever writer landed first. */
    previousRecords: Map<string, MessageRecord | undefined>
    /** Cached infos at plan time: the finalize pass re-verifies each id
     * before letting the snapshot's info land, so usage published by SSE
     * after the fetch survives the commit. */
    previousInfos: Map<string, MessageInfo | undefined>
    dedupedInputs: MessageUpsertInput[]
    serverIds: string[]
    serverIdSet: Set<string>
    previousMessageIds: string[]
    pendingOptimisticIds: string[]
    omittedIds: string[]
    preservedAfter: Map<string | undefined, string[]>
    incomingIds: string[]
    infoList: MessageInfo[] | undefined
  }

  function planHydration(
    sessionId: string,
    inputs: MessageUpsertInput[],
    infos?: Iterable<MessageInfo>,
    options?: { preserveOmitted?: boolean; confirmPending?: boolean },
  ): HydrationPlan {
    ensureSessionEntry(sessionId)

    // Defensive dedupe by message id: a snapshot should not contain the same
    // id twice, but if it does, every duplicate would be enqueued below as an
    // additional confirmation candidate (consuming extra pending sends) and
    // the id would repeat in session.messageIds. First occurrence wins,
    // preserving snapshot order.
    const seenInputIds = new Set<string>()
    const revertMessageId = state.sessions[sessionId]?.revert?.messageID
    const dedupedInputs = inputs.filter((input) => {
      // V2 revert boundaries use message ID ordering, including when the
      // boundary itself lies outside this resident page (as on commit).
      if (revertMessageId && input.id >= revertMessageId) return false
      if (seenInputIds.has(input.id)) return false
      seenInputIds.add(input.id)
      return true
    })

    const serverIds = dedupedInputs.map((item) => item.id)
    const serverIdSet = new Set(serverIds)
    const previousRecords = new Map<string, MessageRecord | undefined>()
    for (const input of dedupedInputs) {
      previousRecords.set(input.id, state.messages[input.id])
    }
    const membership = reconcileHydrationMembership(sessionId, serverIds, serverIdSet, options)
    const previousMessageIds = membership.previousMessageIds

    const isVisibleInfo = (info: MessageInfo) => !revertMessageId || info.id < revertMessageId
    const infoList = infos ? Array.from(infos).filter(isVisibleInfo) : undefined
    const previousInfos = new Map<string, MessageInfo | undefined>()
    for (const info of infoList ?? []) {
      previousInfos.set(info.id as string, messageInfoCache.get(info.id as string))
    }

    return {
      revertMessageId,
      previousRecords,
      previousInfos,
      dedupedInputs,
      serverIds,
      serverIdSet,
      previousMessageIds,
      pendingOptimisticIds: membership.pendingOptimisticIds,
      omittedIds: membership.omittedIds,
      preservedAfter: membership.preservedAfter,
      incomingIds: membership.incomingIds,
      infoList,
    }
  }

  /** Snapshot-membership reconciliation against the session's CURRENT rows:
   * what a hydrate keeps (pending sends, preserved runs), drops (omitted) and
   * the resulting ordered id list. Shared by the entry plan and the chunked
   * finalize pass, which re-runs it so rows streamed during the chunk yields
   * survive the commit. */
  function reconcileHydrationMembership(
    sessionId: string,
    serverIds: string[],
    serverIdSet: Set<string>,
    options?: { preserveOmitted?: boolean },
    plannedAgainst?: ReadonlySet<string>,
    keepArrivals = false,
  ) {
    // Preserve only requests that have not received a promptAsync response
    // yet. Accepted prompts are confirmed under the same messageID, while
    // rejected requests are marked failed and can be removed by this snapshot.
    const currentIds = state.sessions[sessionId]?.messageIds ?? []
    // The id list the snapshot was planned against: ids resident now but
    // absent from it arrived AFTER the snapshot was fetched (a row streamed
    // between chunk yields). The snapshot never spoke about them, so they
    // survive in place; only ids it replaces may be omitted.
    const baselineIds: ReadonlySet<string> = plannedAgainst ?? new Set(currentIds)
    // For each previous ephemeral "sending" record absent from this snapshot,
    // preserve it ONLY while it is a still-in-flight pending send; otherwise
    // it is stale — a send that already failed, or an ephemeral record the
    // authoritative server does not know about — and is dropped so it cannot
    // linger as a permanent "sending" bubble.
    const pendingOptimisticIds: string[] = []
    const omittedIds: string[] = []
    // HTTP can be ahead of the live reducer: omitted residents may follow or
    // sit between its rows, rather than all belonging to older history. Keep
    // each omitted run after its preceding shared row, using native order.
    const preservedAfter = new Map<string | undefined, string[]>()
    const trailingArrivals: string[] = []
    let keptArrivals = false
    let seenSharedId = false
    let precedingId: string | undefined
    const attach = (id: string) => {
      const run = preservedAfter.get(precedingId) ?? []
      run.push(id)
      preservedAfter.set(precedingId, run)
    }
    for (const id of currentIds) {
      if (serverIdSet.has(id)) {
        seenSharedId = true
        precedingId = id
        continue
      }
      if (!baselineIds.has(id)) {
        // Arrived after the snapshot was planned. The snapshot never spoke
        // about this row: a latest-window load keeps the newer content,
        // while a history replacement drops it exactly as the synchronous
        // path omits rows its page does not hold. The whole arrival run
        // stays anchored after the last shared id - and arrivals that share
        // no id with the page land at the end, where the newest rows
        // belong, instead of ahead of older messages the cap would rather
        // evict.
        if (keepArrivals) {
          if (seenSharedId) attach(id)
          else trailingArrivals.push(id)
          keptArrivals = true
        } else {
          omittedIds.push(id)
        }
        continue
      }
      const record = state.messages[id]
      if (record && preservePendingSendOnOmission(id)) {
        pendingOptimisticIds.push(id)
      } else {
        omittedIds.push(id)
        if (options?.preserveOmitted) {
          attach(id)
        }
      }
    }

    const incomingIds = [
      ...preservedAfter.get(undefined) ?? [],
      ...serverIds.flatMap((id) => [id, ...preservedAfter.get(id) ?? []]),
      ...trailingArrivals,
      ...pendingOptimisticIds,
    ]
    return { previousMessageIds: currentIds, pendingOptimisticIds, omittedIds, preservedAfter, incomingIds, keptArrivals }
  }

  // Computes the changed records for one chunk of inputs, mirroring the
  // synchronous pass record-for-record (unchanged records keep the resident
  // object so their Solid subscribers stay quiet).
  function normalizeHydrationChunk(chunk: MessageUpsertInput[], plan: HydrationPlan): Array<{ id: string; record: MessageRecord; previous: MessageRecord | undefined }> {
    const normalized: Array<{ id: string; record: MessageRecord; previous: MessageRecord | undefined }> = []
    const now = Date.now()
    for (const input of chunk) {
      const normalizedParts = normalizeParts(input.id, input.parts)
      const previous = plan.previousRecords.get(input.id)
      const partsChanged = normalizedParts
        ? havePartsChanged(previous?.partIds, previous?.parts, normalizedParts.ids, normalizedParts.map)
        : false
      const statusChanged = previous ? previous.status !== input.status : true
      const shouldBump = Boolean(input.bumpRevision || partsChanged || statusChanged)
      // Identity reconciliation: a confirmed send reappears under its own id,
      // so `previous` IS the optimistic record and its client-only
      // prompt-display metadata carries over unchanged.
      const clientPromptDisplayMetadata = resolveClientPromptDisplayText(instanceId, input, previous)
      // The window is re-projected on every native event, so unchanged
      // messages must keep their resident record object: replacing it would
      // notify every Solid subscriber of that message and re-render it.
      const recordUnchanged = previous !== undefined && !shouldBump
        && previous.role === input.role
        && previous.sessionId === input.sessionId
        && (input.createdAt === undefined || previous.createdAt === input.createdAt)
        && (input.updatedAt === undefined || previous.updatedAt === input.updatedAt)
        && (input.isEphemeral === undefined || previous.isEphemeral === input.isEphemeral)
        && samePromptDisplayMetadata(clientPromptDisplayMetadata, previous.clientPromptDisplayMetadata)
      if (recordUnchanged) continue
      const record: MessageRecord = {
        id: input.id,
        sessionId: input.sessionId,
        role: input.role,
        status: input.status,
        createdAt: input.createdAt ?? previous?.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
        isEphemeral: input.isEphemeral ?? previous?.isEphemeral ?? false,
        clientPromptDisplayMetadata,
        revision: previous ? previous.revision + (shouldBump ? 1 : 0) : 0,
        partIds: normalizedParts ? normalizedParts.ids : previous?.partIds ?? [],
        parts: normalizedParts ? normalizedParts.map : previous?.parts ?? {},
      }
      normalized.push({ id: input.id, record, previous })
    }
    return normalized
  }

  /** Whether a fetched info carries usage a resident entry lacks: tokens
   * or cost the newer writer did not publish. */
  function snapshotInfoExtends(current: MessageInfo | undefined, fetched: MessageInfo): boolean {
    if (!current) return true
    // Content first: a fetched end the resident entry lacks (or that is at
    // least as recent) lands regardless of usage size.
    const fetchedCompleted = fetched.time?.completed
    const currentCompleted = current.time?.completed
    if (fetchedCompleted !== undefined && (currentCompleted === undefined || fetchedCompleted >= currentCompleted)) return true
    if (currentCompleted !== undefined && fetchedCompleted === undefined) return false
    const currentTokens = current.tokens
    const fetchedTokens = fetched.tokens
    const currentTotal = (currentTokens?.input ?? 0) + (currentTokens?.output ?? 0) + (currentTokens?.reasoning ?? 0)
    const fetchedTotal = (fetchedTokens?.input ?? 0) + (fetchedTokens?.output ?? 0) + (fetchedTokens?.reasoning ?? 0)
    if (fetchedTotal > currentTotal) return true
    return (fetched.cost ?? 0) > (current.cost ?? 0)
  }

  function isTerminalToolStatus(status: unknown): boolean {
    return status === "completed" || status === "error"
  }

  /** Whether a streamed text fragment has its ending committed: the native
   * provider state for text, `time.completed` for reasoning. */
  function isCommittedProsePart(part: ClientPart): boolean {
    if (part.type === "text") return (part as { native?: unknown }).native !== undefined
    if (part.type === "reasoning") return (part as { time?: { completed?: unknown } }).time?.completed !== undefined
    return true
  }

  /** Whether the resident part keeps its version against the fetched one,
   * arbitrating per part on native evidence: a terminal tool state beats an
   * open one, an open prose fragment keeps text the fetched page only
   * prefixes (the stream continued past the fetch), and committed versions
   * order by the records' server timestamps, the fetched page winning ties. */
  function residentPartWins(resident: ClientPart, snapshot: ClientPart, residentUpdatedAt: number, snapshotUpdatedAt: number, residentRecordEnded = false, snapshotRecordEnded = false): boolean {
    if (resident.type !== snapshot.type) return false
    if (resident.type === "tool") {
      const residentTerminal = isTerminalToolStatus((resident as { state?: { status?: unknown } }).state?.status)
      const snapshotTerminal = isTerminalToolStatus((snapshot as { state?: { status?: unknown } }).state?.status)
      if (snapshotTerminal && !residentTerminal) return false
      if (residentTerminal && !snapshotTerminal) return true
      return residentUpdatedAt > snapshotUpdatedAt
    }
    if (resident.type === "text" || resident.type === "reasoning") {
      // Completion evidence orders before any prefix reasoning, read like
      // the native merge's test: a fragment is committed by its own ending
      // or by its message's end, even when only the message carries
      // `time.completed`. The record keeps no end time of its own, so the
      // message's end is its terminal display status - which the
      // normalizer derives from that end: `complete` for a finished
      // message, `error` for an interrupted or failed one (`sent` still
      // means running for shells and compactions). A committed fetched
      // fragment is the final version even when it is shorter than what the
      // open stream displayed (`updatedAt` may hold the creation time and
      // cannot order these).
      const residentCommitted = isCommittedProsePart(resident) || residentRecordEnded
      const snapshotCommitted = isCommittedProsePart(snapshot) || snapshotRecordEnded
      if (snapshotCommitted && !residentCommitted) return false
      if (!residentCommitted) {
        if (!snapshotCommitted) {
          // Two open fragments: the stream continued past the fetch only
          // when the fetched text is a strict prefix of the live text.
          const residentText = typeof (resident as { text?: unknown }).text === "string" ? (resident as { text: string }).text : ""
          const snapshotText = typeof (snapshot as { text?: unknown }).text === "string" ? (snapshot as { text: string }).text : ""
          return snapshotText.length < residentText.length && residentText.startsWith(snapshotText)
        }
        return false
      }
      if (!snapshotCommitted) return true
    }
    return residentUpdatedAt > snapshotUpdatedAt
  }

  /** A winning prose part still carries the fetched fragment's end
   * metadata when the fetched side holds it: the resident text with the
   * snapshot's `time`/`native` completion fields. */
  function prosePartWithFetchedEnd(winner: ClientPart, fetched: ClientPart): ClientPart {
    const merged = { ...winner } as Record<string, unknown>
    let changed = false
    const winnerTime = (winner as { time?: unknown }).time
    const fetchedTime = (fetched as { time?: unknown }).time
    if (fetchedTime !== undefined && winnerTime === undefined) {
      merged.time = fetchedTime
      changed = true
    }
    const winnerNative = (winner as { native?: unknown }).native
    const fetchedNative = (fetched as { native?: unknown }).native
    if (fetchedNative !== undefined && winnerNative === undefined) {
      merged.native = fetchedNative
      changed = true
    }
    return changed ? (merged as unknown as ClientPart) : winner
  }

  /** Merges a fetched record into one the store no longer holds as the
   * chunks diffed it. Prose fragments (text, reasoning) pair by kind and
   * ordinal the way the native merge does - anonymous fragments carry no id
   * to pair on - and every other part pairs by id. The winner above decides
   * each pair; parts only one side holds stay. Returns the resident record
   * when nothing of the snapshot survives. */
  function mergeSnapshotRecord(resident: MessageRecord, next: MessageRecord, keepResidentExtras: boolean): MessageRecord {
    type ProseSide = { id: string; part: MessageRecord["parts"][string]; ordinal: number }
    const proseOf = (record: MessageRecord): Map<string, ProseSide[]> => {
      const byKind = new Map<string, ProseSide[]>()
      let textOrdinal = 0
      let reasoningOrdinal = 0
      for (const id of record.partIds) {
        const part = record.parts[id]?.data
        if (!part) continue
        if (part.type === "text" || part.type === "reasoning") {
          const ordinal = part.type === "text" ? textOrdinal++ : reasoningOrdinal++
          const bucket = byKind.get(part.type) ?? []
          bucket.push({ id, part: record.parts[id]!, ordinal })
          byKind.set(part.type, bucket)
        }
      }
      return byKind
    }
    const residentProse = proseOf(resident)
    const snapshotProse = proseOf(next)
    const residentProseUsed = new Set<string>()
    const snapshotProseUsedSet = new Set<string>()
    const mergedParts: MessageRecord["parts"] = {}
    const mergedIds: string[] = []
    const ended = (record: MessageRecord) => record.status === "complete" || record.status === "error"
    const residentEnded = ended(resident)
    const snapshotEnded = ended(next)
    const canonicalize = (part: MessageRecord["parts"][string], id: string): MessageRecord["parts"][string] => {
      if (part.id === id && (part.data as { id?: unknown }).id === id) return part
      return { ...part, id, data: { ...part.data, id } as ClientPart }
    }
    for (const id of next.partIds) {
      const snapshotPart = next.parts[id]
      const snapshotKind = snapshotPart?.data.type
      if (snapshotPart && (snapshotKind === "text" || snapshotKind === "reasoning")) {
        const ordinal = snapshotProse.get(snapshotKind)?.find((side) => side.id === id)?.ordinal
        const residentSide = ordinal === undefined ? undefined : residentProse.get(snapshotKind)?.find((side) => side.ordinal === ordinal)
        // A resident part won through pairing keeps the pair's canonical
        // id: transcript lookups resolve parts by data.id.
        const snapshotProseUsed = snapshotProseUsedSet
        const residentWon = residentSide !== undefined
          && residentPartWins(residentSide.part.data, snapshotPart.data, resident.updatedAt, next.updatedAt, residentEnded, snapshotEnded)
        if (residentSide) residentProseUsed.add(residentSide.id)
        snapshotProseUsed.add(id)
        if (residentWon) {
          const data = prosePartWithFetchedEnd(residentSide!.part.data, snapshotPart.data)
          const wrapper = data === residentSide!.part.data ? residentSide!.part : { ...residentSide!.part, data }
          mergedParts[id] = canonicalize(wrapper, id)
        } else {
          mergedParts[id] = snapshotPart
        }
        mergedIds.push(id)
        continue
      }
      mergedIds.push(id)
      if (!snapshotPart) continue
      const residentPart = resident.parts[id]
      if (!residentPart) {
        mergedParts[id] = snapshotPart
        continue
      }
      if (residentPartWins(residentPart.data, snapshotPart.data, resident.updatedAt, next.updatedAt, residentEnded, snapshotEnded)) {
        mergedParts[id] = residentPart
      } else {
        mergedParts[id] = snapshotPart
      }
    }
    if (keepResidentExtras) {
      for (const id of resident.partIds) {
        if (mergedIds.includes(id) || residentProseUsed.has(id)) continue
        const residentPart = resident.parts[id]
        if (!residentPart) continue
        const kind = residentPart.data.type
        if (kind === "text" || kind === "reasoning") {
          // Unpaired resident prose beyond the snapshot's ordinals: kept at
          // the tail in resident order - a live stream the fetched page has
          // not reached yet. An authoritative history page drops it.
          mergedIds.push(id)
          mergedParts[id] = residentPart
          continue
        }
        if (!next.parts[id]) {
          mergedIds.push(id)
          mergedParts[id] = residentPart
        }
      }
    }
    // The resident record object is reused only when the merge leaves both
    // its metadata and its part list unchanged (unchanged records keep
    // their object so their subscribers stay quiet). Anything else - an
    // emptied part list included - publishes the merged record.
    const partsUnchanged = mergedIds.length === resident.partIds.length
      && mergedIds.every((id, index) => {
        if (id !== resident.partIds[index]) return false
        const merged = mergedParts[id]
        const current = resident.parts[id]
        return merged === current || (merged !== undefined && current !== undefined && partDataEqual(merged.data, current.data))
      })
    // Status and isEphemeral describe the message's end, so they come from
    // the version whose end won: the side that ended while the other stayed
    // open, else - both ended or both open - the later one by server time,
    // the fetched page winning ties, like the part arbitration.
    const endWinner = residentEnded !== snapshotEnded
      ? (residentEnded ? resident : next)
      : (ended(resident) && resident.updatedAt > next.updatedAt ? resident : next)
    const merged: MessageRecord = {
      ...next,
      status: endWinner.status,
      isEphemeral: endWinner.isEphemeral,
      parts: mergedParts,
      partIds: mergedIds,
      revision: resident.revision + 1,
    }
    const metadataUnchanged = merged.role === resident.role
      && merged.sessionId === resident.sessionId
      && merged.status === resident.status
      && merged.createdAt === resident.createdAt
      && merged.updatedAt === resident.updatedAt
      && merged.isEphemeral === resident.isEphemeral
      && samePromptDisplayMetadata(merged.clientPromptDisplayMetadata, resident.clientPromptDisplayMetadata)
    if (partsUnchanged && metadataUnchanged) return resident
    return merged
  }

  // A chunked hydration computes its chunks across task boundaries but keeps
  // partial results out of the visible store: concurrent structural writes
  // fence the remaining chunks, and the finalize pass commits atomically,
  // re-planning membership against the current rows (rows streamed during the
  // yields survive) and skipping records a newer writer already replaced
  // (live SSE text is never regressed by stale REST content).
  async function hydrateMessagesChunked(
    sessionId: string,
    plan: HydrationPlan,
    options?: { preserveOmitted?: boolean; confirmPending?: boolean; guard?: () => boolean; keepStreamedArrivals?: boolean },
  ): Promise<boolean> {
    const chunks: MessageUpsertInput[][] = []
    for (let start = 0; start < plan.dedupedInputs.length; start += HYDRATE_CHUNK_SIZE) {
      chunks.push(plan.dedupedInputs.slice(start, start + HYDRATE_CHUNK_SIZE))
    }
    const infoById = new Map((plan.infoList ?? []).map((info) => [info.id as string, info]))

    const fenceToken = currentHydrationFence(sessionId)
    const pendingRecords: Array<{ id: string; record: MessageRecord; previous: MessageRecord | undefined }> = []
    const pendingInfos: MessageInfo[] = []
    let contentChanged = false

    for (let index = 0; index < chunks.length; index++) {
      if (index > 0) {
        await yieldToMainThread()
        if (currentHydrationFence(sessionId) !== fenceToken) return false
      }
      for (const entry of normalizeHydrationChunk(chunks[index], plan)) {
        contentChanged = true
        pendingRecords.push(entry)
      }
      for (const input of chunks[index]) {
        const info = infoById.get(input.id)
        if (!info || !plan.serverIdSet.has(info.id as string)) continue
        // Only record the info when its content changed against the
        // plan-time basis: a newer writer (SSE-published usage) is handled
        // by the finalize identity check, not by this comparison.
        const previousInfo = plan.previousInfos.get(info.id as string)
        if (!previousInfo || !messageInfoEqual(previousInfo, info)) {
          pendingInfos.push(info)
        }
      }
    }

    // Recheck cancellation and the native revision right before the finalize
    // writes: a load whose native state moved while its chunks computed (a
    // cancelled jump, an SSE event the fetch never saw) must not publish.
    if (options?.guard && !options.guard()) return false
    // Finalize: re-plan membership against the CURRENT rows so rows streamed
    // during the yields survive, then commit everything in one batch.
    const membership = reconcileHydrationMembership(sessionId, plan.serverIds, plan.serverIdSet, options, new Set(plan.previousMessageIds), options?.keepStreamedArrivals === true)
    const infoChangedAny = pendingInfos.length > 0
    if (!contentChanged && membership.omittedIds.length === 0 && !infoChangedAny
      && areMessageIdListsEqual(membership.previousMessageIds, membership.incomingIds)) {
      // An identical snapshot leaves the whole resident session untouched:
      // no record replacement, no session-entry write, no revision bump.
      if (options?.confirmPending !== false) {
        plan.serverIds.forEach((id) => pendingSendIds.delete(id))
      }
      return true
    }

    // Inbox admission can render before the message endpoint projects the
    // accepted prompt. Only authoritative projection confirms the send.
    if (options?.confirmPending !== false) {
      plan.serverIds.forEach((id) => pendingSendIds.delete(id))
    }

    if (!options?.preserveOmitted && membership.omittedIds.length > 0) {
      membership.omittedIds.forEach((id) => {
        messageInfoCache.delete(id)
        forgetPendingSend(id)
        clearPromptDisplayOverride(instanceId, sessionId, id)
      })
      clearRecordDisplayCacheForMessages(instanceId, membership.omittedIds)
    }
    for (const info of pendingInfos) {
      // A newer writer (SSE-published usage) replaced this id after the
      // plan: keep the published version unless the fetched snapshot is the
      // richer one - a stale queued projection's infoless entry must not
      // hold the fetched end time and tokens back.
      const current = messageInfoCache.get(info.id as string)
      if (current !== plan.previousInfos.get(info.id as string) && !snapshotInfoExtends(current, info)) continue
      messageInfoCache.set(info.id as string, info)
    }
    for (const entry of pendingRecords) {
      setPromptDisplayOverride(instanceId, entry.record.sessionId, entry.id, entry.record.clientPromptDisplayMetadata)
    }
    if (!options?.preserveOmitted && membership.omittedIds.length > 0) {
      hooks?.onMessagesRemoved?.(instanceId, sessionId, membership.omittedIds)
    }

    // Usage merges the snapshot with the resident cache, the cache winning
    // per id: tokens published by SSE events after the fetch must survive a
    // reload that never saw them.
    const usageInfos = plan.infoList
      ? new Map([
          ...plan.infoList.map((info) => [info.id as string, info] as const),
          ...Array.from(messageInfoCache.values())
            .filter((info) => info.sessionID === sessionId && (!plan.revertMessageId || info.id < plan.revertMessageId))
            .map((info) => [info.id as string, info] as const),
        ]).values()
      : undefined
    const usageState = usageInfos ? rebuildUsageStateFromInfos(usageInfos) : undefined

    batch(() => {
      for (const entry of pendingRecords) {
        // The row still holds its plan-time diff basis: the snapshot updates
        // it. Otherwise a newer writer replaced it between the plan and this
        // commit, and per-part native arbitration decides what lands.
        let record = entry.record
        const resident = state.messages[entry.id]
        if (resident !== undefined && resident !== entry.previous) {
          record = mergeSnapshotRecord(resident, entry.record, options?.keepStreamedArrivals === true)
          if (record === resident) continue
        }
        setState("messages", entry.id, record)
      }
      if (!options?.preserveOmitted && membership.omittedIds.length > 0) {
        setState("messages", produce((draft) => {
          membership.omittedIds.forEach((id) => {
            delete draft[id]
          })
        }))
        setState("messageInfoVersion", produce((draft) => {
          membership.omittedIds.forEach((id) => {
            delete draft[id]
          })
        }))
        setState("permissions", produce((draft) => {
          const omitted = new Set(membership.omittedIds)
          membership.omittedIds.forEach((id) => {
            delete draft.byMessage[id]
          })
          draft.queue = draft.queue.filter((entry) => !entry.messageId || !omitted.has(entry.messageId))
          draft.active = draft.queue[0] ?? null
        }))
      }
      for (const info of pendingInfos) {
        setState("messageInfoVersion", info.id as string, (state.messageInfoVersion[info.id as string] ?? 0) + 1)
      }
      if (usageState) {
        setState("usage", sessionId, usageState)
      }
      setState("sessions", sessionId, (session) => ({
        ...session,
        messageIds: membership.incomingIds,
        updatedAt: Date.now(),
      }))
      recomputeLastAssistantMessageId(sessionId, membership.incomingIds)

      clearLatestTodoSnapshot(sessionId)
      membership.incomingIds.forEach((messageId) => {
        maybeUpdateLatestTodoFromRecord(state.messages[messageId])
      })

      bumpSessionRevision(sessionId)
    })
    return true
  }

  function hydrateMessages(
    sessionId: string,
    inputs: MessageUpsertInput[],
    infos?: Iterable<MessageInfo>,
    options?: { preserveOmitted?: boolean; confirmPending?: boolean; chunked?: boolean; guard?: () => boolean; keepStreamedArrivals?: boolean },
  ): void | Promise<boolean> {
    if (!Array.isArray(inputs) || inputs.length === 0) return

    const plan = planHydration(sessionId, inputs, infos, options)

    if (options?.chunked && plan.dedupedInputs.length > HYDRATE_CHUNK_SIZE) {
      // A newer chunked snapshot supersedes an older in-flight one. Sync
      // hydrates (per-frame projections re-projecting the same window) do
      // not fence: committing through them matches the synchronous path's
      // last-writer-wins semantics, so a streaming session cannot starve
      // its own page load.
      fenceSessionHydration(sessionId)
      return hydrateMessagesChunked(sessionId, plan, options)
    }

    const { dedupedInputs, serverIds, serverIdSet, omittedIds, incomingIds, infoList } = plan

    const normalizedRecords: Record<string, MessageRecord> = {}
    const now = Date.now()
    let contentChanged = false

    dedupedInputs.forEach((input) => {
      const normalizedParts = normalizeParts(input.id, input.parts)
      const previous = state.messages[input.id]
      const partsChanged = normalizedParts
        ? havePartsChanged(previous?.partIds, previous?.parts, normalizedParts.ids, normalizedParts.map)
        : false
      const statusChanged = previous ? previous.status !== input.status : true
      const shouldBump = Boolean(input.bumpRevision || partsChanged || statusChanged)
      // Identity reconciliation: a confirmed send reappears under its own id,
      // so `previous` IS the optimistic record and its client-only
      // prompt-display metadata carries over unchanged.
      const clientPromptDisplayMetadata = resolveClientPromptDisplayText(instanceId, input, previous)
      // The window is re-projected on every native event, so unchanged
      // messages must keep their resident record object: replacing it would
      // notify every Solid subscriber of that message and re-render it.
      const recordUnchanged = Boolean(previous) && !shouldBump
        && previous.role === input.role
        && previous.sessionId === input.sessionId
        && (input.createdAt === undefined || previous.createdAt === input.createdAt)
        && (input.updatedAt === undefined || previous.updatedAt === input.updatedAt)
        && (input.isEphemeral === undefined || previous.isEphemeral === input.isEphemeral)
        && samePromptDisplayMetadata(clientPromptDisplayMetadata, previous.clientPromptDisplayMetadata)
      if (recordUnchanged) {
        normalizedRecords[input.id] = previous
        return
      }
      contentChanged = true
      normalizedRecords[input.id] = {
        id: input.id,
        sessionId: input.sessionId,
        role: input.role,
        status: input.status,
        createdAt: input.createdAt ?? previous?.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
        isEphemeral: input.isEphemeral ?? previous?.isEphemeral ?? false,
        clientPromptDisplayMetadata,
        revision: previous ? previous.revision + (shouldBump ? 1 : 0) : 0,
        partIds: normalizedParts ? normalizedParts.ids : previous?.partIds ?? [],
        parts: normalizedParts ? normalizedParts.map : previous?.parts ?? {},
      }
      setPromptDisplayOverride(instanceId, input.sessionId, input.id, clientPromptDisplayMetadata)
    })

    const nextMessages: Record<string, MessageRecord> = { ...state.messages }
    const nextMessageInfoVersion: Record<string, number> = { ...state.messageInfoVersion }
    const nextPermissionsByMessage: Record<string, Record<string, PermissionEntry>> = {
      ...state.permissions.byMessage,
    }

    Object.entries(normalizedRecords).forEach(([id, record]) => {
      nextMessages[id] = record
    })

    // The snapshot is authoritative: remove every omitted record except a
    // request that is still awaiting same-ID persistence confirmation.
    if (!options?.preserveOmitted && omittedIds.length > 0) {
      omittedIds.forEach((id) => {
        messageInfoCache.delete(id)
        forgetPendingSend(id)
        clearPromptDisplayOverride(instanceId, sessionId, id)
        delete nextMessages[id]
        delete nextMessageInfoVersion[id]
        delete nextPermissionsByMessage[id]
      })
      clearRecordDisplayCacheForMessages(instanceId, omittedIds)
      hooks?.onMessagesRemoved?.(instanceId, sessionId, omittedIds)
    }

    // Inbox admission can render before the message endpoint projects the
    // accepted prompt. Only authoritative projection confirms the send.
    if (options?.confirmPending !== false) {
      serverIds.forEach((id) => {
        pendingSendIds.delete(id)
      })
    }

    let infoChangedAny = false
    if (infoList) {
      for (const info of infoList) {
        const messageId = info.id as string
        if (!serverIdSet.has(messageId)) continue
        // Only bump the info version -- which participates in message-block's
        // render-cache signature -- when the info content actually changed.
        // An identical snapshot (the common case on a reconnect force-reload)
        // must not invalidate those caches.
        const previousInfo = messageInfoCache.get(messageId)
        const infoChanged = !previousInfo || !messageInfoEqual(previousInfo, info)
        if (!infoChanged) continue
        infoChangedAny = true
        messageInfoCache.set(messageId, info)
        const currentVersion = nextMessageInfoVersion[messageId] ?? 0
        nextMessageInfoVersion[messageId] = currentVersion + 1
      }
    }

    // An identical snapshot leaves the whole resident session untouched: no
    // record replacement, no session-entry write, no revision bump. This is
    // what keeps a re-projected window from invalidating every mounted row.
    if (!contentChanged && omittedIds.length === 0 && !infoChangedAny
      && areMessageIdListsEqual(plan.previousMessageIds, incomingIds)) {
      return
    }

    const usageInfos = options?.preserveOmitted && infoList
      ? new Map([
          ...Array.from(messageInfoCache.values())
            .filter((info) => info.sessionID === sessionId && (!plan.revertMessageId || info.id < plan.revertMessageId))
            .map((info) => [info.id as string, info] as const),
          ...infoList.map((info) => [info.id as string, info] as const),
        ]).values()
      : infoList
    const usageState = usageInfos ? rebuildUsageStateFromInfos(usageInfos) : state.usage[sessionId]

    batch(() => {
      setState("messages", () => nextMessages)
      setState("messageInfoVersion", () => nextMessageInfoVersion)
      setState("permissions", "byMessage", () => nextPermissionsByMessage)

      // Solid store object updates merge, so omitted keys are deleted explicitly.
      if (!options?.preserveOmitted && omittedIds.length > 0) {
        setState(
          "messages",
          produce((draft) => {
            omittedIds.forEach((id) => {
              delete draft[id]
            })
          }),
        )
        setState(
          "messageInfoVersion",
          produce((draft) => {
            omittedIds.forEach((id) => {
              delete draft[id]
            })
          }),
        )
        setState(
          "permissions",
          produce((draft) => {
            const omitted = new Set(omittedIds)
            omittedIds.forEach((id) => {
              delete draft.byMessage[id]
            })
            draft.queue = draft.queue.filter((entry) => !entry.messageId || !omitted.has(entry.messageId))
            draft.active = draft.queue[0] ?? null
          }),
        )
      }

      if (usageState) {
        setState("usage", sessionId, usageState)
      }

      setState("sessions", sessionId, (session) => ({
        ...session,
        messageIds: incomingIds,
        updatedAt: Date.now(),
      }))
      recomputeLastAssistantMessageId(sessionId, incomingIds)

      clearLatestTodoSnapshot(sessionId)
      incomingIds.forEach((messageId) => {
        maybeUpdateLatestTodoFromRecord(nextMessages[messageId])
      })

      bumpSessionRevision(sessionId)
    })
  }

  function reconcileAuthoritativeMessageIds(
    sessionId: string,
    authoritativeIds: ReadonlySet<string>,
    baselineRevisions: ReadonlyMap<string, number>,
  ) {
    // A structural reconcile fences an in-flight chunked hydration.
    fenceSessionHydration(sessionId)
    const retainedIds = (state.sessions[sessionId]?.messageIds ?? [])
      .filter((id) => !baselineRevisions.has(id)
        || authoritativeIds.has(id)
        || state.messages[id]?.revision !== baselineRevisions.get(id))
    if (retainedIds.length === 0) {
      reconcileEmptyAuthoritativeSnapshot(sessionId)
      return
    }
    hydrateMessages(
      sessionId,
      retainedIds.flatMap((id) => {
        const record = state.messages[id]
        if (!record) return []
        return [{
          id: record.id,
          sessionId: record.sessionId,
          role: record.role,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          isEphemeral: record.isEphemeral,
          parts: record.partIds.flatMap((partId) => record.parts[partId]?.data ?? []),
          bumpRevision: false,
        }]
      }),
      retainedIds.flatMap((id) => messageInfoCache.get(id) ?? []),
    )
  }

  // Register an optimistic user send while promptAsync is unresolved.
  function markSendPending(messageId: string) {
    if (!messageId) return
    pendingSendIds.add(messageId)
  }

  function updateSendRecord(messageId: string, status: "sent" | "error") {
    fenceSessionHydration(state.messages[messageId]?.sessionId ?? "")
    const record = state.messages[messageId]
    if (!record || (record.status !== "sending" && !(status === "error" && record.status === "sent"))) return
    setState(
      "messages",
      messageId,
      produce((draft) => {
        draft.status = status
        draft.isEphemeral = status === "error"
        draft.updatedAt = Date.now()
        draft.revision += 1
      }),
    )
    bumpSessionRevision(record.sessionId)
  }

  // A 204 response means processing was accepted, but the marker remains until
  // REST or SSE confirms persistence under the same messageID.
  function acceptSend(messageId: string) {
    updateSendRecord(messageId, "sent")
  }

  // Request preparation or prompt submission failed. Keep an error bubble
  // until the next authoritative snapshot rather than preserving "sending".
  function failSend(messageId: string) {
    if (!pendingSendIds.has(messageId)) return
    pendingSendIds.delete(messageId)
    updateSendRecord(messageId, "error")
  }

  function failPendingSends(sessionId: string) {
    for (const messageId of Array.from(pendingSendIds)) {
      if (state.messages[messageId]?.sessionId === sessionId) failSend(messageId)
    }
  }

  function retirePendingSends(sessionId: string) {
    let changed = false
    for (const messageId of Array.from(pendingSendIds)) {
      const record = state.messages[messageId]
      if (record?.sessionId === sessionId && record.status === "sent") {
        pendingSendIds.delete(messageId)
        changed = true
      }
    }
    if (changed) hooks?.onSessionChanged?.(instanceId, sessionId)
  }

  // Apply an AUTHORITATIVE empty snapshot (server returned zero messages for
  // this session on a forced reconnect load). hydrateMessages ignores empty
  // input, so this path exists to clear stale records the server no longer
  // knows about while still preserving genuinely in-flight optimistic sends.
  function reconcileEmptyAuthoritativeSnapshot(sessionId: string) {
    fenceSessionHydration(sessionId)
    const session = state.sessions[sessionId]
    if (!session) return
    const previousMessageIds = session.messageIds ?? []
    const keptPendingIds: string[] = []
    const droppedIds: string[] = []
    for (const id of previousMessageIds) {
      const record = state.messages[id]
      if (record && preservePendingSendOnOmission(id)) {
        keptPendingIds.push(id)
      } else {
        droppedIds.push(id)
      }
    }
    if (droppedIds.length === 0) return

    droppedIds.forEach((id) => {
      messageInfoCache.delete(id)
      forgetPendingSend(id)
      clearPromptDisplayOverride(instanceId, sessionId, id)
    })
    clearRecordDisplayCacheForMessages(instanceId, droppedIds)
    hooks?.onMessagesRemoved?.(instanceId, sessionId, droppedIds)

    batch(() => {
      setState(
        "messages",
        produce((draft) => {
          droppedIds.forEach((id) => {
            delete draft[id]
          })
        }),
      )
      setState(
        "messageInfoVersion",
        produce((draft) => {
          droppedIds.forEach((id) => {
            delete draft[id]
          })
        }),
      )
      setState(
        "permissions",
        produce((draft) => {
          const dropped = new Set(droppedIds)
          droppedIds.forEach((id) => {
            delete draft.byMessage[id]
          })
          draft.queue = draft.queue.filter((entry) => !entry.messageId || !dropped.has(entry.messageId))
          draft.active = draft.queue[0] ?? null
        }),
      )
      setState("usage", sessionId, createEmptyUsageState())
      setState("latestTodos", sessionId, undefined)
      setState("sessions", sessionId, (current) => ({
        ...current,
        messageIds: keptPendingIds,
        updatedAt: Date.now(),
      }))
      recomputeLastAssistantMessageId(sessionId, keptPendingIds)
      bumpSessionRevision(sessionId)
    })
  }

  function insertMessageIntoSession(sessionId: string, messageId: string) {
    ensureSessionEntry(sessionId)
    setState("sessions", sessionId, "messageIds", (ids = []) => {
      if (ids.includes(messageId)) {
        return ids
      }
      return [...ids, messageId]
    })
  }

  function normalizeParts(messageId: string, parts: ClientPart[] | undefined) {
    // Omitted parts are a metadata-only update. An explicit empty snapshot is
    // authoritative too: pruning the last technical part must clear the cache.
    if (!parts) {
      return null
    }
    const map: MessageRecord["parts"] = {}
    const ids: string[] = []
    const seenIds = new Set<string>()

    parts.forEach((part, index) => {
      const id = ensurePartId(messageId, part, index)
      const cloned = clonePart(part)
      map[id] = {
        id,
        data: cloned,
        revision: 0,
      }
      if (!seenIds.has(id)) {
        seenIds.add(id)
        ids.push(id)
      }
    })

    return { map, ids }
  }

  function upsertMessage(input: MessageUpsertInput) {
    fenceSessionHydration(input.sessionId)
    const normalizedParts = normalizeParts(input.id, input.parts)
    const shouldBump = Boolean(input.bumpRevision || normalizedParts)
    const now = Date.now()

    let nextRecord: MessageRecord | undefined

    setState("messages", input.id, (previous) => {
      const revision = previous ? previous.revision + (shouldBump ? 1 : 0) : 0
      const clientPromptDisplayMetadata = resolveClientPromptDisplayText(instanceId, input, previous)
      const record: MessageRecord = {
        id: input.id,
        sessionId: input.sessionId,
        role: input.role,
        status: input.status,
        createdAt: input.createdAt ?? previous?.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
        isEphemeral: input.isEphemeral ?? previous?.isEphemeral ?? false,
        clientPromptDisplayMetadata,
        revision,
        partIds: normalizedParts ? normalizedParts.ids : previous?.partIds ?? [],
        parts: normalizedParts ? normalizedParts.map : previous?.parts ?? {},
      }
      setPromptDisplayOverride(instanceId, input.sessionId, input.id, clientPromptDisplayMetadata)
      nextRecord = record
      return record
    })

    if (nextRecord) {
      maybeUpdateLatestTodoFromRecord(nextRecord)
    }

    // A record that is no longer an in-flight optimistic "sending" bubble
    // (confirmed by identity via SSE/REST, or otherwise terminal) must not
    // keep a pending marker, or a later authoritative snapshot could preserve
    // a stale entry.
    if (nextRecord && !(nextRecord.isEphemeral && nextRecord.status === "sending")) {
      pendingSendIds.delete(input.id)
    }

    insertMessageIntoSession(input.sessionId, input.id)
    recomputeLastAssistantMessageId(input.sessionId)
    bumpSessionRevision(input.sessionId)
  }

  function removeMessage(messageId: string, fallbackSessionId?: string) {
    if (!messageId) return

    fenceSessionHydration(state.messages[messageId]?.sessionId ?? fallbackSessionId ?? "")
    forgetPendingSend(messageId)

    const record = state.messages[messageId]
    const sessionIds = new Set<string>()

    if (record?.sessionId) {
      clearPromptDisplayOverride(instanceId, record.sessionId, messageId)
    }

    if (record?.sessionId) {
      sessionIds.add(record.sessionId)
    } else {
      Object.values(state.sessions).forEach((session) => {
        if (session.messageIds.includes(messageId)) {
          sessionIds.add(session.id)
        }
      })
    }
    if (!sessionIds.size && fallbackSessionId) sessionIds.add(fallbackSessionId)

    clearRecordDisplayCacheForMessages(instanceId, [messageId])
    sessionIds.forEach((sessionId) => hooks?.onMessagesRemoved?.(instanceId, sessionId, [messageId]))

    batch(() => {
      sessionIds.forEach((sessionId) => {
        setState("sessions", sessionId, "messageIds", (ids = []) => ids.filter((id) => id !== messageId))
      })

      setState("messages", produce((draft) => {
        delete draft[messageId]
      }))

      setState("messageInfoVersion", produce((draft) => {
        delete draft[messageId]
      }))

      messageInfoCache.delete(messageId)

      setState("permissions", "byMessage", produce((draft) => {
        delete draft[messageId]
      }))

      sessionIds.forEach((sessionId) => {
        withUsageState(sessionId, (draft) => removeUsageEntry(draft, messageId))
        if (state.latestTodos[sessionId]?.messageId === messageId) {
          clearLatestTodoSnapshot(sessionId)
        }
        recomputeLastAssistantMessageId(sessionId)
        bumpSessionRevision(sessionId)
      })
    })
  }

  function removeMessagePart(messageId: string, partId: string, fallbackSessionId?: string) {
    if (!messageId || !partId) return
    fenceSessionHydration(state.messages[messageId]?.sessionId ?? fallbackSessionId ?? "")
    const message = state.messages[messageId]
    if (!message) {
      if (fallbackSessionId) bumpSessionRevision(fallbackSessionId)
      return
    }

    clearRecordDisplayCacheForMessages(instanceId, [messageId])

    batch(() => {
      setState(
        "messages",
        messageId,
        produce((draft: MessageRecord) => {
          if (!draft.parts[partId] && !draft.partIds.includes(partId)) return
          draft.partIds = draft.partIds.filter((id) => id !== partId)
          delete draft.parts[partId]
          draft.updatedAt = Date.now()
          draft.revision += 1
        }),
      )

      setState("permissions", "byMessage", messageId, (prev) => {
        if (!prev || !prev[partId]) return prev
        const next = { ...prev }
        delete next[partId]
        return next
      })

      bumpSessionRevision(message.sessionId)
    })
  }

  function replaceMessageId(options: ReplaceMessageIdOptions) {
    if (options.oldId === options.newId) return
    fenceSessionHydration(state.messages[options.oldId]?.sessionId ?? "")
    const existing = state.messages[options.oldId]
    if (!existing) return

    movePromptDisplayOverride(instanceId, existing.sessionId, options.oldId, options.newId)

    // The optimistic send is now confirmed under its real id; retire the
    // pending marker (carry it to the new id only if still mid-flight).
    if (pendingSendIds.has(options.oldId) && existing.isEphemeral && existing.status === "sending") {
      forgetPendingSend(options.oldId)
      pendingSendIds.add(options.newId)
    }

    const cloned: MessageRecord = {
      ...existing,
      id: options.newId,
      isEphemeral: false,
      updatedAt: Date.now(),
      partIds: options.clearParts ? [] : existing.partIds,
      parts: options.clearParts ? {} : existing.parts,
    }

    setState("messages", options.newId, cloned)
    setState("messages", produce((draft) => {
      delete draft[options.oldId]
    }))

    const affectedSessions = new Set<string>()

    Object.values(state.sessions).forEach((session) => {
      const index = session.messageIds.indexOf(options.oldId)
      if (index === -1) return
      setState("sessions", session.id, "messageIds", (ids) => {
        const next = [...ids]
        next[index] = options.newId
        return next
      })
      affectedSessions.add(session.id)
    })

    affectedSessions.forEach((sessionId) => {
      recomputeLastAssistantMessageId(sessionId)
      bumpSessionRevision(sessionId)
    })

    const infoEntry = messageInfoCache.get(options.oldId)
    if (infoEntry) {
      messageInfoCache.set(options.newId, infoEntry)
      messageInfoCache.delete(options.oldId)
      const version = state.messageInfoVersion[options.oldId] ?? 0
      setState("messageInfoVersion", options.newId, version)
      setState("messageInfoVersion", (prev) => {
        const next = { ...prev }
        delete next[options.oldId]
        return next
      })
    }

    const permissionMap = state.permissions.byMessage[options.oldId]
    if (permissionMap) {
      setState("permissions", "byMessage", options.newId, permissionMap)
      setState("permissions", (prev) => {
        const next = { ...prev }
        const nextByMessage = { ...next.byMessage }
        delete nextByMessage[options.oldId]
        next.byMessage = nextByMessage
        return next
      })
    }

    maybeUpdateLatestTodoFromRecord(cloned)
  }

  function setMessageInfo(messageId: string, info: MessageInfo) {
    if (!messageId) return
    messageInfoCache.set(messageId, info)
    const nextVersion = (state.messageInfoVersion[messageId] ?? 0) + 1
    setState("messageInfoVersion", messageId, nextVersion)
    updateUsageWithInfo(info)
  }

  function getMessageInfo(messageId: string) {
    void state.messageInfoVersion[messageId]
    return messageInfoCache.get(messageId)
  }

  function mergePermissionEntry(entry: PermissionEntry): PermissionEntry {
    const existing = state.permissions.queue.find((item) => item.permission.id === entry.permission.id)
    if (!existing) return entry
    return {
      ...entry,
      permission: mergePermissionRequest(existing.permission, entry.permission),
      messageId: entry.messageId ?? existing.messageId,
      partId: entry.partId ?? existing.partId,
      enqueuedAt: Math.min(existing.enqueuedAt, entry.enqueuedAt),
    }
  }

  function upsertPermission(input: PermissionEntry) {
    const entry = mergePermissionEntry(input)
    const messageKey = entry.messageId ?? "__global__"
    const partKey = entry.partId ?? entry.permission?.id ?? "__global__"
    const existing = state.permissions.queue.find((item) => item.permission.id === entry.permission.id)
    const existingAtLocation = state.permissions.byMessage[messageKey]?.[partKey]
    const expectedActiveId = state.permissions.queue[0]?.permission.id
    if (shouldSkipPendingRequestUpsert({
      existing,
      existingAtLocationId: existingAtLocation?.permission.id,
      expectedActiveId,
      activeId: state.permissions.active?.permission.id,
      incomingId: entry.permission.id,
      incomingMessageId: entry.messageId,
      incomingPartId: entry.partId,
      incomingEnqueuedAt: entry.enqueuedAt,
      existingValue: existing?.permission,
      incomingValue: entry.permission,
    })) {
      return
    }

    setState(
      "permissions",
      produce((draft) => {
        Object.keys(draft.byMessage).forEach((existingMessageKey) => {
          const partEntries = draft.byMessage[existingMessageKey]
          Object.keys(partEntries).forEach((existingPartKey) => {
            if (partEntries[existingPartKey].permission.id === entry.permission.id) {
              delete partEntries[existingPartKey]
            }
          })
          if (Object.keys(partEntries).length === 0) {
            delete draft.byMessage[existingMessageKey]
          }
        })
        draft.byMessage[messageKey] = draft.byMessage[messageKey] ?? {}
        draft.byMessage[messageKey][partKey] = entry
        const existingIndex = draft.queue.findIndex((item) => item.permission.id === entry.permission.id)
        if (existingIndex === -1) {
          draft.queue.push(entry)
        } else {
          draft.queue[existingIndex] = entry
        }
        draft.queue.sort((left, right) => left.enqueuedAt - right.enqueuedAt)
        draft.active = draft.queue[0] ?? null
      }),
    )
  }

  function removePermission(permissionId: string) {
    setState(
      "permissions",
      produce((draft) => {
        draft.queue = draft.queue.filter((item) => item.permission.id !== permissionId)
        if (draft.active?.permission.id === permissionId) {
          draft.active = draft.queue[0] ?? null
        }
        Object.keys(draft.byMessage).forEach((messageKey) => {
          const partEntries = draft.byMessage[messageKey]
          Object.keys(partEntries).forEach((partKey) => {
            if (partEntries[partKey].permission.id === permissionId) {
              delete partEntries[partKey]
            }
          })
          if (Object.keys(partEntries).length === 0) {
            delete draft.byMessage[messageKey]
          }
        })
      }),
    )
  }

  function getPermissionState(messageId?: string, partId?: string) {
    const messageKey = messageId ?? "__global__"
    const partKey = partId ?? "__global__"
    const entry = state.permissions.byMessage[messageKey]?.[partKey]
    if (!entry) return null
    const active = state.permissions.active?.permission.id === entry.permission.id
    return { entry, active }
  }

  function pruneMessagesAfterRevert(sessionId: string, revertMessageId: string) {
    const session = state.sessions[sessionId]
    if (!session) return
    const stopIndex = session.messageIds.findIndex((id) => id >= revertMessageId)
    if (stopIndex === -1) return
    const removedIds = session.messageIds.slice(stopIndex)
    if (removedIds.length === 0) return

    // Use the normal removal path: Solid merges object updates, so merely
    // omitting keys does not delete records or invalidate their render caches.
    batch(() => {
      removedIds.forEach((id) => removeMessage(id, sessionId))
    })
  }

  function setSessionRevert(sessionId: string, revert?: SessionRecord["revert"] | null) {
    if (!sessionId) return
    fenceSessionHydration(sessionId)
    ensureSessionEntry(sessionId)
    if (revert?.messageID) {
      pruneMessagesAfterRevert(sessionId, revert.messageID)
    }
    setState("sessions", sessionId, "revert", revert ?? null)
    bumpSessionRevision(sessionId)
  }

  function getSessionRevert(sessionId: string) {
    return state.sessions[sessionId]?.revert ?? null
  }

  function makeScrollKey(sessionId: string, scope: string) {
    return `${sessionId}:${scope}`
  }

  // A snapshot is a whole position: replace the stored one rather than merging
  // into it, or an unanchored capture would inherit a previous anchor.
  function setScrollSnapshot(sessionId: string, scope: string, snapshot: Omit<ScrollSnapshot, "updatedAt">) {
    const key = makeScrollKey(sessionId, scope)
    const next = { ...snapshot, updatedAt: Date.now() }
    setState("scrollState", { [key]: next })
    hooks?.onScrollSnapshotChanged?.(instanceId, sessionId, scope, next)
  }

  function restoreScrollSnapshot(sessionId: string, scope: string, snapshot: ScrollSnapshot) {
    const key = makeScrollKey(sessionId, scope)
    setState("scrollState", { [key]: snapshot })
  }

  function getScrollSnapshot(sessionId: string, scope: string) {
    const key = makeScrollKey(sessionId, scope)
    return state.scrollState[key]
  }

  function setMessageWindow(sessionId: string, window: MessageWindowState) {
    ensureSessionEntry(sessionId)
    // Window state is authoritative, not a partial patch. Solid's default
    // object merge otherwise retains a history resumeCursor on latest pages.
    const next: MessageWindowState = { kind: window.kind, newerCursors: [...window.newerCursors] }
    if (window.resumeCursor !== undefined) next.resumeCursor = window.resumeCursor
    if (window.olderCursor !== undefined) next.olderCursor = window.olderCursor
    setState("sessions", sessionId, produce((session) => { session.messageWindow = next }))
  }

  function getMessageWindow(sessionId: string) {
    return state.sessions[sessionId]?.messageWindow
  }

  function trimSessionMessages(sessionId: string, limit: number) {
    const ids = state.sessions[sessionId]?.messageIds ?? []
    const overflow = ids.length - Math.max(1, Math.floor(limit))
    for (const messageId of ids.slice(0, Math.max(0, overflow))) removeMessage(messageId, sessionId)
  }

  function clearSession(sessionId: string, options?: { preserveScroll?: boolean; preservePromptDisplayOverrides?: boolean; notify?: boolean }) {
    if (!sessionId) return

    fenceSessionHydration(sessionId)

    if (!options?.preservePromptDisplayOverrides) clearPromptDisplayOverridesForSession(instanceId, sessionId)

    // The session record owns its message ids (insertMessageIntoSession keeps
    // record and list in sync). Reading them from the record keeps clearing one
    // session linear in its own size; scanning every resident message of the
    // instance through store proxies made an N-session deletion burst
    // quadratic. The scan remains the fallback for a session without a record.
    const sessionRecord = state.sessions[sessionId]
    const messageIds = sessionRecord
      ? sessionRecord.messageIds.filter((id) => Boolean(state.messages[id]))
      : Object.values(state.messages)
        .filter((record) => record.sessionId === sessionId)
        .map((record) => record.id)
    const messageIdSet = new Set(messageIds)
 
    storeLog.info("Clearing session data", { instanceId, sessionId, messageCount: messageIds.length })
    clearRecordDisplayCacheForMessages(instanceId, messageIds)
    clearSessionMessageRenderCache(instanceId, sessionId)
    messageIds.forEach((id) => forgetPendingSend(id))
 
    batch(() => {
      // Store setters merge returned objects: omitted keys still retain their
      // payloads. Delete through produce before retiring byte accounting.
      setState("messages", produce((draft) => {
        messageIds.forEach((id) => delete draft[id])
      }))

      setState("messageInfoVersion", produce((draft) => {
        messageIds.forEach((id) => delete draft[id])
      }))

      messageIds.forEach((id) => messageInfoCache.delete(id))

      const belongsToSession = (entry: PermissionEntry) => entry.permission.sessionID === sessionId
        || Boolean(entry.messageId && messageIdSet.has(entry.messageId))
      setState("permissions", produce((draft) => {
        draft.queue = draft.queue.filter((entry) => !belongsToSession(entry))
        draft.active = draft.queue[0] ?? null
        for (const messageId of Object.keys(draft.byMessage)) {
          const entries = draft.byMessage[messageId]
          for (const partId of Object.keys(entries)) {
            if (messageIdSet.has(messageId) || belongsToSession(entries[partId])) delete entries[partId]
          }
          if (Object.keys(entries).length === 0) delete draft.byMessage[messageId]
        }
      }))

      setState("usage", produce((draft) => { delete draft[sessionId] }))
      setState("sessionRevisions", produce((draft) => { delete draft[sessionId] }))
      setState("lastAssistantMessageIds", produce((draft) => { delete draft[sessionId] }))

      if (!options?.preserveScroll) {
        setState("scrollState", produce((draft) => {
          const prefix = `${sessionId}:`
          Object.keys(draft).forEach((key) => {
            if (key.startsWith(prefix)) {
              delete draft[key]
            }
          })
        }))
      }

      setState("sessions", sessionId, (current) => {
        if (!current) return current
        return { ...current, messageIds: [] }
      })

      setState("sessions", produce((draft) => { delete draft[sessionId] }))

      setState("sessionOrder", (ids) => ids.filter((id) => id !== sessionId))
    })

    clearLatestTodoSnapshot(sessionId)
 
    if (options?.notify !== false) hooks?.onSessionCleared?.(instanceId, sessionId)
  }

  function evictSessionTranscript(sessionId: string) {
    clearSession(sessionId, { preserveScroll: true, preservePromptDisplayOverrides: true })
  }

 
   function clearInstance() {
     for (const sessionId of Object.keys(unwrap(state.sessions))) fenceSessionHydration(sessionId)
     clearPromptDisplayOverridesForInstance(instanceId, Object.keys(state.sessions))
     clearRecordDisplayCacheForInstance(instanceId)
     clearInstanceMessageRenderCaches(instanceId)
     messageInfoCache.clear()
     pendingSendIds.clear()
      setState(reconcile(createInitialState(instanceId)))
    }

    function clearScrollSnapshots() {
      setState("scrollState", reconcile({}))
    }
 
    return {

     instanceId,
     state,
     setState,
     addOrUpdateSession,
      hydrateMessages,
      reconcileEmptyAuthoritativeSnapshot,
      reconcileAuthoritativeMessageIds,
      markSendPending,
      acceptSend,
      failSend,
      failPendingSends,
      retirePendingSends,
      upsertMessage,
      removeMessage,
      removeMessagePart,
     replaceMessageId,
     setMessageInfo,
     getMessageInfo,
      upsertPermission,
      removePermission,
      getPermissionState,

     setSessionRevert,
     getSessionRevert,
      rebuildUsage,
      getSessionUsage,
      setScrollSnapshot,
      restoreScrollSnapshot,
      getScrollSnapshot,
      setMessageWindow,
      getMessageWindow,
      getSessionRevision: getSessionRevisionValue,
      getSessionMessageIds: (sessionId: string) => state.sessions[sessionId]?.messageIds ?? [],
      getLastAssistantMessageId: getLastAssistantMessageIdValue,
      getLastCompactionMessageIndex,
      getMessage: (messageId: string) => state.messages[messageId],
      getLatestTodoSnapshot,
      hasPendingSends,
      trimSessionMessages,
      estimateSessionRetainedBytes,
      hasLiveSessionMessages,
      evictSessionTranscript,
      clearSession,
      clearScrollSnapshots,
      clearInstance,
     }
   }
