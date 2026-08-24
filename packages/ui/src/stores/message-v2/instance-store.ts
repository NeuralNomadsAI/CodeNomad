import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { SetStoreFunction } from "solid-js/store"
import { getLogger } from "../../lib/logger"
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
import { clearRecordDisplayCacheForMessages } from "./record-display-cache"
import { shouldSkipPendingRequestUpsert } from "./pending-request-dedupe"
import type {
  InstanceMessageState,
  LatestTodoSnapshot,
  MessageRecord,
  MessageUpsertInput,
  PartUpdateInput,
  PendingPartEntry,
  PermissionEntry,
  ReplaceMessageIdOptions,
  ScrollSnapshot,
  SessionRecord,
  SessionUpsertInput,
  SessionUsageState,
  UsageEntry,
} from "./types"
import type { MessageWindowState } from "./message-window"

const storeLog = getLogger("session")

interface MessageStoreHooks {
  onSessionCleared?: (instanceId: string, sessionId: string) => void
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
    pendingParts: {},
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

const PENDING_PART_MAX_AGE_MS = 30_000

function clonePart(part: ClientPart): ClientPart {
  // Cloning is intentionally disabled; message parts
  // are stored as received from the backend.
  return part
}

function cloneStructuredValue<T>(value: T): T {
  // Legacy helper kept as a no-op to avoid deep copies.
  return value
}

function areMessageIdListsEqual(a: string[], b: string[]): boolean {
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
  hydrateMessages: (sessionId: string, inputs: MessageUpsertInput[], infos?: Iterable<MessageInfo>, options?: { preserveOmitted?: boolean }) => void
  reconcileEmptyAuthoritativeSnapshot: (sessionId: string) => void
  reconcileAuthoritativeMessageIds: (sessionId: string, authoritativeIds: ReadonlySet<string>, baselineRevisions: ReadonlyMap<string, number>) => void
  markSendPending: (messageId: string) => void
  acceptSend: (messageId: string) => void
  confirmServerMessage: (messageId: string, options?: { clearOptimisticParts?: boolean }) => void
  failSend: (messageId: string) => void
  failPendingSends: (sessionId: string) => void
  retirePendingSends: (sessionId: string) => void
  upsertMessage: (input: MessageUpsertInput) => void
  applyPartUpdate: (input: PartUpdateInput) => void
  applyPartDelta: (input: {
    messageId: string
    partId: string
    field: string
    delta: string
    bumpRevision?: boolean
    bumpSessionRevision: boolean
  }) => void
  removeMessage: (messageId: string, fallbackSessionId?: string) => void
  removeMessagePart: (messageId: string, partId: string, fallbackSessionId?: string) => void
  bufferPendingPart: (entry: PendingPartEntry) => void
  flushPendingParts: (messageId: string) => void
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
  clearSession: (sessionId: string, options?: { preserveScroll?: boolean; notify?: boolean }) => void
  clearScrollSnapshots: () => void
  clearInstance: () => void
}

export function createInstanceMessageStore(instanceId: string, hooks?: MessageStoreHooks): InstanceMessageStore {
  const [state, setState] = createStore<InstanceMessageState>(createInitialState(instanceId))

  const TODO_TOOL_NAME = "todowrite"

  const messageInfoCache = new Map<string, MessageInfo>()

  // Requests awaiting same-ID persistence confirmation.
  const pendingSendIds = new Set<string>()
  const optimisticPartIdsByMessage = new Map<string, Set<string>>()

  function forgetPendingSend(messageId: string): void {
    pendingSendIds.delete(messageId)
    optimisticPartIdsByMessage.delete(messageId)
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
      revert: input.revert ?? session.revert ?? null,
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
      if (JSON.stringify(prevPart.data) !== JSON.stringify(nextPart.data)) return true
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

  function hydrateMessages(
    sessionId: string,
    inputs: MessageUpsertInput[],
    infos?: Iterable<MessageInfo>,
    options?: { preserveOmitted?: boolean },
  ) {
    if (!Array.isArray(inputs) || inputs.length === 0) return

    ensureSessionEntry(sessionId)

    // Defensive dedupe by message id: a snapshot should not contain the same
    // id twice, but if it does, every duplicate would be enqueued below as an
    // additional confirmation candidate (consuming extra pending sends) and
    // the id would repeat in session.messageIds. First occurrence wins,
    // preserving snapshot order.
    const seenInputIds = new Set<string>()
    const dedupedInputs = inputs.filter((input) => {
      if (seenInputIds.has(input.id)) return false
      seenInputIds.add(input.id)
      return true
    })

    const serverIds = dedupedInputs.map((item) => item.id)
    const serverIdSet = new Set(serverIds)
    const serverIdsWithParts = new Set(dedupedInputs.filter((item) => item.parts?.length).map((item) => item.id))

    // Preserve only requests that have not received a promptAsync response
    // yet. Accepted prompts are confirmed under the same messageID, while
    // rejected requests are marked failed and can be removed by this snapshot.
    const previousMessageIds = state.sessions[sessionId]?.messageIds ?? []
    // For each previous ephemeral "sending" record absent from this snapshot,
    // preserve it ONLY while it is a still-in-flight pending send; otherwise
    // it is stale — a send that already failed, or an ephemeral record the
    // authoritative server does not know about — and is dropped so it cannot
    // linger as a permanent "sending" bubble.
    const pendingOptimisticIds: string[] = []
    const omittedIds: string[] = []
    for (const id of previousMessageIds) {
      if (serverIdSet.has(id)) continue
      const record = state.messages[id]
      if (record && preservePendingSendOnOmission(id)) {
        pendingOptimisticIds.push(id)
      } else {
        omittedIds.push(id)
      }
    }

    const preservedIds = options?.preserveOmitted ? omittedIds : []
    const incomingIds = [...preservedIds, ...serverIds, ...pendingOptimisticIds]

    const normalizedRecords: Record<string, MessageRecord> = {}
    const now = Date.now()

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

    const infoList = infos ? Array.from(infos) : undefined
    const usageInfos = options?.preserveOmitted && infoList
      ? new Map([
          ...Array.from(messageInfoCache.values())
            .filter((info) => info.sessionID === sessionId)
            .map((info) => [info.id as string, info] as const),
          ...infoList.map((info) => [info.id as string, info] as const),
        ]).values()
      : infoList
    const usageState = usageInfos ? rebuildUsageStateFromInfos(usageInfos) : state.usage[sessionId]

    const nextMessages: Record<string, MessageRecord> = { ...state.messages }
    const nextMessageInfoVersion: Record<string, number> = { ...state.messageInfoVersion }
    const nextPendingParts: Record<string, PendingPartEntry[]> = { ...state.pendingParts }
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
        delete nextPendingParts[id]
        delete nextPermissionsByMessage[id]
      })
      clearRecordDisplayCacheForMessages(instanceId, omittedIds)
    }

    // A send that reappears under its own id is confirmed — it is no longer in
    // flight, so retire its pending marker.
    serverIds.forEach((id) => {
      pendingSendIds.delete(id)
      if (serverIdsWithParts.has(id)) optimisticPartIdsByMessage.delete(id)
    })

    if (infoList) {
      for (const info of infoList) {
        const messageId = info.id as string
        // Only bump the info version -- which participates in message-block's
        // render-cache signature -- when the info content actually changed.
        // An identical snapshot (the common case on a reconnect force-reload)
        // must not invalidate those caches.
        const previousInfo = messageInfoCache.get(messageId)
        const infoChanged = !previousInfo || JSON.stringify(previousInfo) !== JSON.stringify(info)
        messageInfoCache.set(messageId, info)
        if (infoChanged) {
          const currentVersion = nextMessageInfoVersion[messageId] ?? 0
          nextMessageInfoVersion[messageId] = currentVersion + 1
        }
      }
    }

    batch(() => {
      setState("messages", () => nextMessages)
      setState("messageInfoVersion", () => nextMessageInfoVersion)
      setState("pendingParts", () => nextPendingParts)
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
          "pendingParts",
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
    const record = state.messages[messageId]
    optimisticPartIdsByMessage.set(messageId, new Set(record?.partIds ?? []))
  }

  function updateSendRecord(messageId: string, status: "sent" | "error") {
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

  function confirmServerMessage(messageId: string, options?: { clearOptimisticParts?: boolean }) {
    const clientPartIds = optimisticPartIdsByMessage.get(messageId)
    pendingSendIds.delete(messageId)
    if (options?.clearOptimisticParts) optimisticPartIdsByMessage.delete(messageId)
    const record = state.messages[messageId]
    if (!record) return
    const optimisticPartIds = options?.clearOptimisticParts && record.role === "user"
      ? record.partIds.filter((id) => clientPartIds?.has(id))
      : []
    const shouldSettleUser = record.role === "user" && (record.status === "sending" || record.status === "error")
    const changed = Boolean(record.isEphemeral || optimisticPartIds.length > 0 || shouldSettleUser)
    if (!changed) return
    setState(
      "messages",
      messageId,
      produce((draft) => {
        draft.isEphemeral = false
        if (shouldSettleUser) draft.status = "sent"
        if (optimisticPartIds.length > 0) {
          const optimisticIds = new Set(optimisticPartIds)
          draft.partIds = draft.partIds.filter((id) => !optimisticIds.has(id))
          optimisticPartIds.forEach((id) => {
            delete draft.parts[id]
          })
        }
        draft.updatedAt = Date.now()
        draft.revision += 1
      }),
    )
    bumpSessionRevision(record.sessionId)
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
    for (const messageId of Array.from(pendingSendIds)) {
      const record = state.messages[messageId]
      if (record?.sessionId === sessionId && record.status === "sent") pendingSendIds.delete(messageId)
    }
  }

  // Apply an AUTHORITATIVE empty snapshot (server returned zero messages for
  // this session on a forced reconnect load). hydrateMessages ignores empty
  // input, so this path exists to clear stale records the server no longer
  // knows about while still preserving genuinely in-flight optimistic sends.
  function reconcileEmptyAuthoritativeSnapshot(sessionId: string) {
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
        "pendingParts",
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
    if (!parts || parts.length === 0) {
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
    flushPendingParts(input.id)
    recomputeLastAssistantMessageId(input.sessionId)
    bumpSessionRevision(input.sessionId)
  }

  function bufferPendingPart(entry: PendingPartEntry) {
    setState("pendingParts", entry.messageId, (list = []) => [...list, entry])
  }

  function clearPendingPartsForMessage(messageId: string) {
    setState("pendingParts", (prev) => {
      if (!prev[messageId]) {
        return prev
      }
      const next = { ...prev }
      delete next[messageId]
      return next
    })
  }

  function rebindPermissionForPart(messageId: string, partId: string, part: ClientPart) {
    if (!messageId || !partId || part.type !== "tool") {
      return
    }

    const toolCallId =
      (part as any).callID ??
      (part as any).callId ??
      (part as any).toolCallID ??
      (part as any).toolCallId ??
      (part as any).id ??
      undefined
    if (!toolCallId) {
      return
    }

    setState(
      "permissions",
      "byMessage",
      messageId,
      produce((draft) => {
        if (!draft) return
        const existing = draft[partId]
        for (const [key, entry] of Object.entries(draft)) {
          if (!entry || entry.partId) continue
          const permissionCallId =
            (entry.permission as any).tool?.callID ??
            (entry.permission as any).tool?.callId ??
            (entry.permission as any).callID ??
            (entry.permission as any).callId ??
            (entry.permission as any).toolCallID ??
            (entry.permission as any).toolCallId ??
            (entry.permission as any).metadata?.callID ??
            (entry.permission as any).metadata?.callId ??
            undefined
          if (permissionCallId !== toolCallId) continue
          if (!existing || existing.permission.id === entry.permission.id) {
            entry.partId = partId
            draft[partId] = entry
            delete draft[key]
          }
          break
        }
      }),
    )
  }

  function applyPartUpdate(input: PartUpdateInput) {
    const message = state.messages[input.messageId]
    if (!message) {
      bufferPendingPart({ messageId: input.messageId, part: input.part, receivedAt: Date.now() })
      return
    }

    const partId = ensurePartId(input.messageId, input.part, message.partIds.length)
    const cloned = clonePart(input.part)

    setState(
      "messages",
      input.messageId,
      produce((draft: MessageRecord) => {
        if (!draft.partIds.includes(partId)) {
          draft.partIds = [...draft.partIds, partId]
        }
        const existing = draft.parts[partId]
        const nextRevision = existing ? existing.revision + 1 : (cloned as any).version ?? 0
        draft.parts[partId] = {
          id: partId,
          data: cloned,
          revision: nextRevision,
        }
        draft.updatedAt = Date.now()
        if (input.bumpRevision ?? true) {
          draft.revision += 1
        }
      }),
    )

    rebindPermissionForPart(input.messageId, partId, cloned)

    if (isCompletedTodoPart(cloned)) {
      recordLatestTodoSnapshot(message.sessionId, {
        messageId: input.messageId,
        partId,
        timestamp: Date.now(),
      })
    }
  
    // Any part update can change the rendered height of the message
    // list, so we treat it as a session revision for scroll purposes.
    bumpSessionRevision(message.sessionId)
  }

  function applyPartDelta(input: {
    messageId: string
    partId: string
    field: string
    delta: string
    bumpRevision?: boolean
    bumpSessionRevision?: boolean
  }) {
    if (!input?.messageId || !input.partId || !input.field || typeof input.delta !== "string") {
      return
    }

    const message = state.messages[input.messageId]
    if (!message) {
      // Best-effort: drop deltas for unknown messages.
      return
    }

    let applied = false

    setState(
      "messages",
      input.messageId,
      produce((draft: MessageRecord) => {
        const entry = draft.parts[input.partId]
        if (!entry?.data) return
        const part = entry.data as any
        const currentValue = part?.[input.field]
        if (typeof currentValue === "string" || currentValue === undefined || currentValue === null) {
          part[input.field] = `${currentValue ?? ""}${input.delta}`
          applied = true
        }
        if (!applied) return
        entry.revision += 1
        draft.updatedAt = Date.now()
        if (input.bumpRevision ?? true) {
          draft.revision += 1
        }
      }),
    )

    if (applied && (input.bumpSessionRevision ?? true)) {
      bumpSessionRevision(message.sessionId)
    }
  }

  function removeMessage(messageId: string, fallbackSessionId?: string) {
    if (!messageId) return

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

      setState("pendingParts", produce((draft) => {
        delete draft[messageId]
      }))

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


  function flushPendingParts(messageId: string) {
    const pending = state.pendingParts[messageId]
    if (!pending || pending.length === 0) {
      return
    }
    const now = Date.now()
    const validEntries = pending.filter((entry) => now - entry.receivedAt <= PENDING_PART_MAX_AGE_MS)
    if (validEntries.length === 0) {
      clearPendingPartsForMessage(messageId)
      return
    }
    validEntries.forEach((entry) => applyPartUpdate({ messageId, part: entry.part }))
    clearPendingPartsForMessage(messageId)
  }

  function replaceMessageId(options: ReplaceMessageIdOptions) {
    if (options.oldId === options.newId) return
    const existing = state.messages[options.oldId]
    if (!existing) return

    movePromptDisplayOverride(instanceId, existing.sessionId, options.oldId, options.newId)

    // The optimistic send is now confirmed under its real id; retire the
    // pending marker (carry it to the new id only if still mid-flight).
    if (pendingSendIds.has(options.oldId) && existing.isEphemeral && existing.status === "sending") {
      const optimisticParts = optimisticPartIdsByMessage.get(options.oldId)
      forgetPendingSend(options.oldId)
      pendingSendIds.add(options.newId)
      if (optimisticParts) optimisticPartIdsByMessage.set(options.newId, optimisticParts)
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

    const pending = state.pendingParts[options.oldId]
    if (pending) {
      setState("pendingParts", options.newId, pending)
    }
    clearPendingPartsForMessage(options.oldId)
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
    const stopIndex = session.messageIds.indexOf(revertMessageId)
    if (stopIndex === -1) return
    const removedIds = session.messageIds.slice(stopIndex)
    const keptIds = session.messageIds.slice(0, stopIndex)
    if (removedIds.length === 0) return

    removedIds.forEach((messageId) => clearPromptDisplayOverride(instanceId, sessionId, messageId))

    setState("sessions", sessionId, "messageIds", keptIds)

    setState("messages", (prev) => {
      const next = { ...prev }
      removedIds.forEach((id) => delete next[id])
      return next
    })

    setState("messageInfoVersion", (prev) => {
      const next = { ...prev }
      removedIds.forEach((id) => delete next[id])
      return next
    })

    removedIds.forEach((id) => messageInfoCache.delete(id))

    setState("pendingParts", (prev) => {
      const next = { ...prev }
      removedIds.forEach((id) => {
        if (next[id]) delete next[id]
      })
      return next
    })

    setState("permissions", "byMessage", (prev) => {
      const next = { ...prev }
      removedIds.forEach((id) => {
        if (next[id]) delete next[id]
      })
      return next
    })

    withUsageState(sessionId, (draft) => {
      removedIds.forEach((id) => removeUsageEntry(draft, id))
    })

    recomputeLastAssistantMessageId(sessionId, keptIds)
    bumpSessionRevision(sessionId)
  }

  function setSessionRevert(sessionId: string, revert?: SessionRecord["revert"] | null) {
    if (!sessionId) return
    ensureSessionEntry(sessionId)
    if (revert?.messageID) {
      pruneMessagesAfterRevert(sessionId, revert.messageID)
    }
    setState("sessions", sessionId, "revert", revert ?? null)
  }

  function getSessionRevert(sessionId: string) {
    return state.sessions[sessionId]?.revert ?? null
  }

  function makeScrollKey(sessionId: string, scope: string) {
    return `${sessionId}:${scope}`
  }

  function setScrollSnapshot(sessionId: string, scope: string, snapshot: Omit<ScrollSnapshot, "updatedAt">) {
    const key = makeScrollKey(sessionId, scope)
    const next = { ...snapshot, updatedAt: Date.now() }
    setState("scrollState", key, next)
    hooks?.onScrollSnapshotChanged?.(instanceId, sessionId, scope, next)
  }

  function restoreScrollSnapshot(sessionId: string, scope: string, snapshot: ScrollSnapshot) {
    const key = makeScrollKey(sessionId, scope)
    setState("scrollState", key, snapshot)
  }

  function getScrollSnapshot(sessionId: string, scope: string) {
    const key = makeScrollKey(sessionId, scope)
    return state.scrollState[key]
  }

  function setMessageWindow(sessionId: string, window: MessageWindowState) {
    ensureSessionEntry(sessionId)
    setState("sessions", sessionId, "messageWindow", window)
  }

  function getMessageWindow(sessionId: string) {
    return state.sessions[sessionId]?.messageWindow
  }

  function clearSession(sessionId: string, options?: { preserveScroll?: boolean; notify?: boolean }) {
    if (!sessionId) return

    clearPromptDisplayOverridesForSession(instanceId, sessionId)

    const messageIds = Object.values(state.messages)
      .filter((record) => record.sessionId === sessionId)
      .map((record) => record.id)
 
    storeLog.info("Clearing session data", { instanceId, sessionId, messageCount: messageIds.length })
    clearRecordDisplayCacheForMessages(instanceId, messageIds)
    messageIds.forEach((id) => forgetPendingSend(id))
 
    batch(() => {
      setState("messages", (prev) => {
        const next = { ...prev }
        messageIds.forEach((id) => delete next[id])
        return next
      })

      setState("messageInfoVersion", (prev) => {
        const next = { ...prev }
        messageIds.forEach((id) => delete next[id])
        return next
      })

      messageIds.forEach((id) => messageInfoCache.delete(id))

      setState("pendingParts", (prev) => {
        const next = { ...prev }
        messageIds.forEach((id) => {
          if (next[id]) delete next[id]
        })
        return next
      })

      setState("permissions", "byMessage", (prev) => {
        const next = { ...prev }
        messageIds.forEach((id) => {
          if (next[id]) delete next[id]
        })
        return next
      })

      setState("usage", (prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })

      setState("sessionRevisions", (prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })

      setState("lastAssistantMessageIds", (prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })

      if (!options?.preserveScroll) {
        setState("scrollState", (prev) => {
          const next = { ...prev }
          const prefix = `${sessionId}:`
          Object.keys(next).forEach((key) => {
            if (key.startsWith(prefix)) {
              delete next[key]
            }
          })
          return next
        })
      }

      setState("sessions", sessionId, (current) => {
        if (!current) return current
        return { ...current, messageIds: [] }
      })

      setState("sessions", (prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })

      setState("sessionOrder", (ids) => ids.filter((id) => id !== sessionId))
    })

    clearLatestTodoSnapshot(sessionId)
 
    if (options?.notify !== false) hooks?.onSessionCleared?.(instanceId, sessionId)
  }

 
   function clearInstance() {
     clearPromptDisplayOverridesForInstance(instanceId, Object.keys(state.sessions))
     messageInfoCache.clear()
     pendingSendIds.clear()
     optimisticPartIdsByMessage.clear()
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
      confirmServerMessage,
      failSend,
      failPendingSends,
      retirePendingSends,
      upsertMessage,
      applyPartUpdate,
      applyPartDelta,
      removeMessage,
      removeMessagePart,
      bufferPendingPart,
      flushPendingParts,
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
      clearSession,
      clearScrollSnapshots,
      clearInstance,
     }
   }
