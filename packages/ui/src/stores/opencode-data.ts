import type { OpenCodeEvent, SessionMessageInfo } from "@opencode-ai/client"
import { createData, type Data } from "@opencode-ai/client/solid"
import { createRoot, createSignal } from "solid-js"
import { getRootClient } from "./opencode-client"
import { seedSessionMessagesV2 } from "./message-v2/bridge"
import { normalizeSessionMessage } from "./message-v2/normalizers"
import { MESSAGE_WINDOW_PAGE_SIZE } from "./message-v2/message-window"
import { messageStoreBus } from "./message-v2/bus"
import { sseManager } from "../lib/sse-manager"

type DataEntry = {
  data: Data
  emit: (event: OpenCodeEvent) => void
  syncMessages: (sessionId: string, messages: SessionMessageInfo[], isCurrent: () => boolean) => Promise<boolean>
  syncAuthoritative: (sessionId: string, isCurrent: () => boolean) => Promise<boolean>
  dispose: () => void
}

type QueuedTranscriptEvent = {
  event: OpenCodeEvent
  onApplied?: (data: Data) => void
}

type TranscriptEntry = {
  entry: DataEntry
  directory: string
  generation: number
  rotating: boolean
  rotationGeneration: number
  needsAuthoritativeResync: boolean
  resyncing: boolean
  resyncGeneration: number
  freshEntry?: DataEntry
  retryCount: number
  retryTimer?: ReturnType<typeof setTimeout>
  queue: QueuedTranscriptEvent[]
  onResynced?: (data: Data) => void
}

const MAX_ACTIVE_TRANSCRIPT_MESSAGES = 32
const MAX_TRANSCRIPT_MESSAGES = MESSAGE_WINDOW_PAGE_SIZE
// ponytail: overflow collapses all native deltas; one quiet, revision-stable fresh snapshot becomes authority.
const MAX_TRANSCRIPT_EVENT_QUEUE = 4096
const MAX_ROTATION_RESERVE = 64
const TRANSCRIPT_RESYNC_QUIET_MS = 25
const TRANSCRIPT_RETRY_DELAY_MS = 25
const MAX_TRANSCRIPT_RETRY_DELAY_MS = 1000
const entries = new Map<string, DataEntry>()
const transcriptEntries = new Map<string, TranscriptEntry>()
const mutationRevisions = new Map<string, ReturnType<typeof createSignal<number>>>()
const messageRevisions = new Map<string, number>()
const fullDataRevisions = new Map<string, number>()
const instanceGenerations = new Map<string, number>()
const instanceDataRevisions = new Map<string, ReturnType<typeof createSignal<number>>>()
let nextInstanceGeneration = 0

function messageRevisionKey(instanceId: string, sessionId: string): string {
  return `${instanceId}\0${sessionId}`
}

function mutationRevision(key: string): ReturnType<typeof createSignal<number>> {
  let revision = mutationRevisions.get(key)
  if (!revision) {
    revision = createSignal(0)
    mutationRevisions.set(key, revision)
  }
  return revision
}

function instanceDataRevision(instanceId: string): ReturnType<typeof createSignal<number>> {
  let revision = instanceDataRevisions.get(instanceId)
  if (!revision) {
    revision = createSignal(0)
    instanceDataRevisions.set(instanceId, revision)
  }
  return revision
}

function bumpMutationRevision(key: string): void {
  mutationRevision(key)[1]((current) => current + 1)
}

export function getOpenCodeInstanceGeneration(instanceId: string): number {
  let generation = instanceGenerations.get(instanceId)
  if (generation === undefined) {
    generation = ++nextInstanceGeneration
    instanceGenerations.set(instanceId, generation)
  }
  return generation
}

function createDataEntry(instanceId: string, directory: string): DataEntry {
  const listeners = new Set<(event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void>()
  const messageSnapshots = new Map<string, SessionMessageInfo[]>()
  return createRoot((dispose) => {
    const event = {
      listen(handler: (event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void) {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      on(type: OpenCodeEvent["type"], handler: (event: OpenCodeEvent) => void) {
        return event.listen(({ details }) => {
          if (details.type === type) handler(details)
        })
      },
    }
    const api = () => {
      const client = getRootClient(instanceId)
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "message") return Reflect.get(target, property, receiver)
          return new Proxy(client.message, {
            get(messageTarget, messageProperty, messageReceiver) {
              if (messageProperty !== "list") return Reflect.get(messageTarget, messageProperty, messageReceiver)
              return async (input: { sessionID: string }, options?: unknown) => {
                const snapshot = messageSnapshots.get(input.sessionID)
                if (snapshot) return { data: [...snapshot].reverse(), cursor: {} }
                return (client.message.list as any)(input, options)
              }
            },
          })
        },
      })
    }
    const data = createData({
      api: api as any,
      directory,
      event: event as any,
      connection: {
        status: () => sseManager.getStatuses().get(instanceId) === "connected" ? "connected" : "reconnecting",
      },
    })
    const emit = (details: OpenCodeEvent) => {
      for (const listener of listeners) listener({ name: details.type, details })
    }
    return {
      data,
      emit(details: OpenCodeEvent) {
        emit(details)
      },
      async syncMessages(sessionId: string, messages: SessionMessageInfo[], isCurrent: () => boolean) {
        messageSnapshots.set(sessionId, messages)
        try {
          data.session.message.invalidate(sessionId)
          await data.session.message.sync(sessionId)
          return isCurrent()
        } finally {
          messageSnapshots.delete(sessionId)
        }
      },
      async syncAuthoritative(sessionId: string, isCurrent: () => boolean) {
        const client = getRootClient(instanceId)
        const activeRequest = client.session.active()
        data.session.invalidate(sessionId)
        data.session.pending.invalidate(sessionId)
        data.session.message.invalidate(sessionId)
        data.session.permission.invalidate(sessionId)
        data.session.form.invalidate(sessionId)
        const [, , , , , active] = await Promise.all([
          data.session.sync(sessionId),
          data.session.pending.sync(sessionId),
          data.session.message.sync(sessionId),
          data.session.permission.sync(sessionId),
          data.session.form.sync(sessionId),
          activeRequest,
        ])
        if (!isCurrent()) return false
        data.session.setStatus(sessionId, sessionId in active ? "running" : "idle")
        return true
      },
      dispose,
    }
  })
}

function ensureData(instanceId: string, directory: string) {
  const existing = entries.get(instanceId)
  if (existing) return existing
  const entry = createDataEntry(instanceId, directory)
  entries.set(instanceId, entry)
  return entry
}

function ensureTranscript(instanceId: string, sessionId: string, directory: string) {
  const key = messageRevisionKey(instanceId, sessionId)
  const existing = transcriptEntries.get(key)
  if (existing) return existing
  const transcript: TranscriptEntry = {
    entry: createDataEntry(instanceId, directory),
    directory,
    generation: getOpenCodeInstanceGeneration(instanceId),
    rotating: false,
    rotationGeneration: 0,
    needsAuthoritativeResync: false,
    resyncing: false,
    resyncGeneration: 0,
    retryCount: 0,
    queue: [],
  }
  transcriptEntries.set(key, transcript)
  return transcript
}

function isActiveTranscriptMessage(message: any): boolean {
  return (message.type === "assistant" && !message.time?.completed)
    || (message.type === "shell" && message.status === "running")
    || (message.type === "compaction" && message.status === "running")
}

function boundedTranscript(messages: SessionMessageInfo[], limit = MAX_TRANSCRIPT_MESSAGES): SessionMessageInfo[] {
  const active = messages.filter(isActiveTranscriptMessage).slice(-MAX_ACTIVE_TRANSCRIPT_MESSAGES)
  const completedLimit = Math.max(0, limit - active.length)
  const completed = messages
    .filter((message) => !isActiveTranscriptMessage(message))
    .slice(-completedLimit)
  const retained = new Set([...completed, ...active].map((message) => message.id))
  return messages
    .filter((message) => retained.has(message.id))
    .map((message) => JSON.parse(JSON.stringify(message)) as SessionMessageInfo)
}

function eventMayAppendMessage(event: OpenCodeEvent, runningCompactions = 0): boolean {
  switch (event.type) {
    case "session.agent.selected":
    case "session.model.selected":
    case "session.moved":
    case "session.synthetic":
    case "session.shell.started":
    case "session.step.started":
    case "session.compaction.started":
      return true
    case "session.compaction.ended":
    case "session.compaction.failed":
      return runningCompactions === 0
    case "session.instructions.updated":
      return event.data.text !== undefined
    case "session.inbox.enqueued":
      return event.data.item.type === "user" || event.data.item.type === "synthetic"
    default:
      return false
  }
}

function eventAffectsMessages(event: OpenCodeEvent): boolean {
  switch (event.type) {
    case "session.agent.selected":
    case "session.model.selected":
    case "session.moved":
    case "session.inbox.delivered":
    case "session.inbox.cancelled":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.synthetic":
    case "session.step.started":
    case "session.step.ended":
    case "session.step.failed":
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended":
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended":
    case "session.tool.input.started":
    case "session.tool.input.delta":
    case "session.tool.input.ended":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed":
    case "session.retry.scheduled":
    case "session.revert.committed":
    case "session.compaction.started":
    case "session.compaction.delta":
    case "session.compaction.ended":
    case "session.compaction.failed":
    case "session.shell.started":
    case "session.shell.ended":
    case "session.skill.activated":
      return true
    case "session.instructions.updated":
      return event.data.text !== undefined
    case "session.inbox.enqueued":
      return event.data.item.type === "user" || event.data.item.type === "synthetic"
    case "session.created":
    case "session.renamed":
    case "session.viewed":
    case "session.inbox.delivery.changed":
    case "session.execution.started":
    case "session.revert.staged":
    case "session.revert.cleared":
    case "session.status":
    case "session.idle":
    case "session.usage.updated":
    case "session.forked":
      return false
    default:
      return event.type.startsWith("session.")
  }
}

function getOpenCodeFullDataRevision(instanceId: string, sessionId: string): number {
  return fullDataRevisions.get(messageRevisionKey(instanceId, sessionId)) ?? 0
}

function isTranscriptCurrent(instanceId: string, sessionId: string, transcript: TranscriptEntry): boolean {
  return transcriptEntries.get(messageRevisionKey(instanceId, sessionId)) === transcript
    && getOpenCodeInstanceGeneration(instanceId) === transcript.generation
}

function isRotationCurrent(
  instanceId: string,
  sessionId: string,
  transcript: TranscriptEntry,
  entry: DataEntry,
  generation: number,
): boolean {
  return isTranscriptCurrent(instanceId, sessionId, transcript)
    && !transcript.resyncing
    && transcript.entry === entry
    && transcript.rotationGeneration === generation
}

function clearTranscriptRetry(transcript: TranscriptEntry): void {
  if (transcript.retryTimer) clearTimeout(transcript.retryTimer)
  transcript.retryTimer = undefined
}

function retryDelay(transcript: TranscriptEntry): number {
  return Math.min(TRANSCRIPT_RETRY_DELAY_MS * 2 ** transcript.retryCount, MAX_TRANSCRIPT_RETRY_DELAY_MS)
}

function scheduleAuthoritativeResync(
  instanceId: string,
  sessionId: string,
  transcript: TranscriptEntry,
  delay = TRANSCRIPT_RESYNC_QUIET_MS,
): void {
  if (!isTranscriptCurrent(instanceId, sessionId, transcript)) return
  transcript.needsAuthoritativeResync = true
  if (transcript.resyncing) return
  clearTranscriptRetry(transcript)
  const run = () => {
    transcript.retryTimer = undefined
    void resyncAuthoritativeTranscript(instanceId, sessionId, transcript)
  }
  transcript.retryTimer = setTimeout(run, delay)
}

function collapseTranscriptQueue(instanceId: string, sessionId: string, transcript: TranscriptEntry): void {
  transcript.queue = []
  if (!transcript.needsAuthoritativeResync) {
    transcript.rotationGeneration += 1
    transcript.rotating = false
  }
  scheduleAuthoritativeResync(instanceId, sessionId, transcript)
}

function isResyncCurrent(
  instanceId: string,
  sessionId: string,
  transcript: TranscriptEntry,
  generation: number,
  fresh: DataEntry,
): boolean {
  return isTranscriptCurrent(instanceId, sessionId, transcript)
    && transcript.resyncing
    && transcript.resyncGeneration === generation
    && transcript.freshEntry === fresh
}

async function resyncAuthoritativeTranscript(
  instanceId: string,
  sessionId: string,
  transcript: TranscriptEntry,
): Promise<void> {
  if (!isTranscriptCurrent(instanceId, sessionId, transcript)
    || !transcript.needsAuthoritativeResync
    || transcript.resyncing) return
  transcript.resyncing = true
  const generation = ++transcript.resyncGeneration
  const fresh = createDataEntry(instanceId, transcript.directory)
  transcript.freshEntry = fresh
  const instanceGeneration = getOpenCodeInstanceGeneration(instanceId)
  const revision = getOpenCodeFullDataRevision(instanceId, sessionId)
  let swapped = false
  try {
    const synced = await fresh.syncAuthoritative(
      sessionId,
      () => isResyncCurrent(instanceId, sessionId, transcript, generation, fresh)
        && getOpenCodeInstanceGeneration(instanceId) === instanceGeneration
        && getOpenCodeFullDataRevision(instanceId, sessionId) === revision,
    )
    if (!isResyncCurrent(instanceId, sessionId, transcript, generation, fresh)) return
    if (!synced
      || getOpenCodeInstanceGeneration(instanceId) !== instanceGeneration
      || getOpenCodeFullDataRevision(instanceId, sessionId) !== revision) {
      transcript.resyncing = false
      transcript.freshEntry = undefined
      scheduleAuthoritativeResync(instanceId, sessionId, transcript)
      return
    }

    const previous = transcript.entry
    transcript.entry = fresh
    transcript.freshEntry = undefined
    transcript.needsAuthoritativeResync = false
    transcript.resyncing = false
    transcript.retryCount = 0
    swapped = true
    previous.dispose()

    transcript.onResynced?.(fresh.data)
  } catch {
    if (!isResyncCurrent(instanceId, sessionId, transcript, generation, fresh)) return
    transcript.resyncing = false
    transcript.freshEntry = undefined
    transcript.retryCount += 1
    scheduleAuthoritativeResync(instanceId, sessionId, transcript, retryDelay(transcript))
  } finally {
    if (!swapped) fresh.dispose()
  }
}

function enqueueTranscriptEvent(
  instanceId: string,
  sessionId: string,
  transcript: TranscriptEntry,
  queued: QueuedTranscriptEvent,
): void {
  transcript.queue.push(queued)
  if (transcript.queue.length >= MAX_TRANSCRIPT_EVENT_QUEUE) {
    collapseTranscriptQueue(instanceId, sessionId, transcript)
  }
}

function drainTranscriptQueue(
  instanceId: string,
  sessionId: string,
  transcript: TranscriptEntry,
  entry: DataEntry,
  generation: number,
): boolean {
  while (transcript.queue.length > 0) {
    if (!isRotationCurrent(instanceId, sessionId, transcript, entry, generation)) return false
    const queued = transcript.queue[0]
    const runningCompactions = entry.data.session.message.list(sessionId)
      .filter((message) => message.type === "compaction" && message.status === "running").length
    if (eventMayAppendMessage(queued.event, runningCompactions)
      && entry.data.session.message.list(sessionId).length >= MAX_TRANSCRIPT_MESSAGES) return true
    transcript.queue.shift()
    entry.emit(queued.event)
    if (!isRotationCurrent(instanceId, sessionId, transcript, entry, generation)) return false
    queued.onApplied?.(entry.data)
    if (!isRotationCurrent(instanceId, sessionId, transcript, entry, generation)) return false
  }
  return true
}

async function rotateTranscript(
  instanceId: string,
  sessionId: string,
  transcript: TranscriptEntry,
  entry: DataEntry,
  generation: number,
): Promise<void> {
  try {
    while (isRotationCurrent(instanceId, sessionId, transcript, entry, generation)) {
      let runningCompactions = entry.data.session.message.list(sessionId)
        .filter((message) => message.type === "compaction" && message.status === "running").length
      const appendCount = transcript.queue.reduce((count, item) => {
        const appends = eventMayAppendMessage(item.event, runningCompactions)
        if (item.event.type === "session.compaction.started") runningCompactions += 1
        if ((item.event.type === "session.compaction.ended" || item.event.type === "session.compaction.failed") && runningCompactions > 0) {
          runningCompactions -= 1
        }
        return count + Number(appends)
      }, 0)
      const reserve = Math.min(Math.max(appendCount, 1), MAX_ROTATION_RESERVE)
      const snapshot = boundedTranscript(
        entry.data.session.message.list(sessionId),
        MAX_TRANSCRIPT_MESSAGES - reserve,
      )
      const synced = await entry.syncMessages(
        sessionId,
        snapshot,
        () => isRotationCurrent(instanceId, sessionId, transcript, entry, generation),
      )
      if (!synced || !isRotationCurrent(instanceId, sessionId, transcript, entry, generation)) return
      if (!drainTranscriptQueue(instanceId, sessionId, transcript, entry, generation)) return
      if (transcript.queue.length === 0) break
    }
  } catch {
    if (!isRotationCurrent(instanceId, sessionId, transcript, entry, generation)) return
    transcript.retryCount += 1
    transcript.queue = []
    transcript.needsAuthoritativeResync = true
    transcript.rotationGeneration += 1
    transcript.rotating = false
    scheduleAuthoritativeResync(instanceId, sessionId, transcript, retryDelay(transcript))
  } finally {
    if (transcript.rotationGeneration === generation) transcript.rotating = false
    if (!isTranscriptCurrent(instanceId, sessionId, transcript) || transcript.entry !== entry) entry.dispose()
  }
}

function startTranscriptRotation(instanceId: string, sessionId: string, transcript: TranscriptEntry): void {
  if (transcript.rotating || transcript.needsAuthoritativeResync || transcript.resyncing || transcript.queue.length === 0) return
  transcript.rotating = true
  const generation = ++transcript.rotationGeneration
  const entry = transcript.entry
  queueMicrotask(() => void rotateTranscript(instanceId, sessionId, transcript, entry, generation))
}

function eventSessionId(event: OpenCodeEvent): string | undefined {
  const sessionId = (event as { data?: { sessionID?: unknown } }).data?.sessionID
  if (typeof sessionId === "string") return sessionId
  if (event.type === "form.created") return event.data.form.sessionID
}

function invalidateTranscript(transcript: TranscriptEntry): void {
  clearTranscriptRetry(transcript)
  transcript.resyncGeneration += 1
  transcript.rotationGeneration += 1
  transcript.needsAuthoritativeResync = false
  transcript.resyncing = false
  transcript.rotating = false
  transcript.queue = []
  transcript.freshEntry?.dispose()
  transcript.freshEntry = undefined
}

export function applyOpenCodeDataEvent(
  instanceId: string,
  directory: string,
  event: OpenCodeEvent,
  onDeferred?: (data: Data) => void,
  onResynced?: (data: Data) => void,
): Data {
  if (event.type === "server.connected") destroyOpenCodeData(instanceId)
  const primary = ensureData(instanceId, directory)
  const sessionId = eventSessionId(event)
  if (event.type === "session.deleted" && typeof sessionId === "string") {
    const key = messageRevisionKey(instanceId, sessionId)
    const transcript = transcriptEntries.get(key)
    transcript?.entry.emit(event)
    if (transcript) {
      invalidateTranscript(transcript)
      transcript.entry.dispose()
    }
    transcriptEntries.delete(key)
    mutationRevisions.delete(key)
    messageRevisions.delete(key)
    fullDataRevisions.delete(key)
    return transcript?.entry.data ?? primary.data
  }
  const transcript = typeof sessionId === "string"
    ? ensureTranscript(instanceId, sessionId, directory)
    : undefined
  const entry = transcript?.entry ?? primary
  if (transcript && typeof sessionId === "string") {
    const key = messageRevisionKey(instanceId, sessionId)
    fullDataRevisions.set(key, (fullDataRevisions.get(key) ?? 0) + 1)
    if (eventAffectsMessages(event)) messageRevisions.set(key, (messageRevisions.get(key) ?? 0) + 1)
    if (event.type === "session.inbox.cancelled" || event.type === "session.revert.committed") bumpMutationRevision(key)
  }
  if (transcript && typeof sessionId === "string") {
    if (onResynced) transcript.onResynced = onResynced
    if (transcript.needsAuthoritativeResync || transcript.resyncing) {
      collapseTranscriptQueue(instanceId, sessionId, transcript)
      return transcript.entry.data
    }
    if (transcript.rotating
      || (eventMayAppendMessage(event, transcript.entry.data.session.message.list(sessionId)
        .filter((message) => message.type === "compaction" && message.status === "running").length)
        && transcript.entry.data.session.message.list(sessionId).length >= MAX_TRANSCRIPT_MESSAGES)) {
      enqueueTranscriptEvent(instanceId, sessionId, transcript, { event, onApplied: onDeferred })
      startTranscriptRotation(instanceId, sessionId, transcript)
      return transcript.entry.data
    }
  }
  entry.emit(event)
  return entry.data
}

export function getOpenCodeMessageRevision(instanceId: string, sessionId: string): number {
  return messageRevisions.get(messageRevisionKey(instanceId, sessionId)) ?? 0
}

export function getOpenCodeMutationRevision(instanceId: string, sessionId: string): number {
  return mutationRevision(messageRevisionKey(instanceId, sessionId))[0]()
}

export function getOpenCodeSessionInbox(instanceId: string, sessionId: string, directory: string) {
  instanceDataRevision(instanceId)[0]()
  return ensureTranscript(instanceId, sessionId, directory).entry.data.session.pending.list(sessionId)
}

export async function syncOpenCodeSessionInbox(instanceId: string, sessionId: string, directory: string): Promise<void> {
  await ensureTranscript(instanceId, sessionId, directory).entry.data.session.pending.sync(sessionId)
}

export function projectOpenCodeMessages(
  instanceId: string,
  sessionId: string,
  data: Data,
  preserveOmitted = true,
  confirmPending = true,
): void {
  const source = data.session.message.list(sessionId).slice(-MESSAGE_WINDOW_PAGE_SIZE)
  const store = messageStoreBus.getOrCreate(instanceId)
  if (source.length) {
    const normalized = source.map((item) => normalizeSessionMessage(sessionId, item))
    seedSessionMessagesV2(
      instanceId,
      { id: sessionId },
      normalized.map((item) => item.message),
      new Map(normalized.map((item) => [item.info.id, item.info])),
      undefined,
      preserveOmitted,
      confirmPending,
    )
  } else if (!preserveOmitted) {
    store.reconcileEmptyAuthoritativeSnapshot(sessionId)
  }
  const excess = store.getSessionMessageIds(sessionId).length - MESSAGE_WINDOW_PAGE_SIZE
  if (excess > 0) {
    for (const messageId of store.getSessionMessageIds(sessionId).slice(0, excess)) store.removeMessage(messageId, sessionId)
  }
}

export function destroyOpenCodeData(instanceId: string): void {
  instanceGenerations.set(instanceId, ++nextInstanceGeneration)
  entries.get(instanceId)?.dispose()
  entries.delete(instanceId)
  const prefix = `${instanceId}\0`
  for (const [key, transcript] of transcriptEntries) {
    if (!key.startsWith(prefix)) continue
    invalidateTranscript(transcript)
    transcript.entry.dispose()
    transcriptEntries.delete(key)
  }
  for (const key of messageRevisions.keys()) {
    if (key.startsWith(prefix)) messageRevisions.delete(key)
  }
  for (const key of fullDataRevisions.keys()) {
    if (key.startsWith(prefix)) fullDataRevisions.delete(key)
  }
  instanceDataRevision(instanceId)[1]((current) => current + 1)
  for (const key of mutationRevisions.keys()) {
    if (key.startsWith(prefix)) mutationRevisions.delete(key)
  }
}
