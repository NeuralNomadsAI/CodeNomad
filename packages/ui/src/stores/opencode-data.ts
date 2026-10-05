import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client"
import { createData, type Data } from "@opencode/client/solid"
import { createRoot, createSignal } from "solid-js"
import { getRootClient } from "./opencode-client"
import { seedSessionMessagesV2 } from "./message-v2/bridge"
import { normalizeSessionMessage } from "./message-v2/normalizers"
import { MESSAGE_WINDOW_PAGE_SIZE } from "./message-v2/message-window"
import { messageStoreBus } from "./message-v2/bus"
import { sseManager } from "../lib/sse-manager"
import { getLogger } from "../lib/logger"
import { createCompactionDeltaBuffer } from "./compaction-delta-buffer"

const log = getLogger("session")

type DataEntry = {
  data: Data
  emit: (event: OpenCodeEvent) => void
  fencePendingReads: (sessionId: string) => void
  syncMessages: (sessionId: string, messages: SessionMessageInfo[], isCurrent: () => boolean) => Promise<boolean>
  syncAuthoritative: (sessionId: string, isCurrent: () => boolean) => Promise<boolean>
  dispose: () => void
}

type QueuedTranscriptEvent = {
  event: OpenCodeEvent
  onApplied?: (data: Data) => void
  publication?: TranscriptPublication
}

type TranscriptPublication = (input: {
  instanceId: string
  sessionId: string
  data: Data
  events: readonly OpenCodeEvent[]
}) => void

// Opt-in publications observe a reduced chunk, not individual event states.
// Legacy onDeferred callbacks remain per-event ordering barriers.
export type OpenCodeDataEventAdmission = {
  deferred: boolean
  publication?: TranscriptPublication
}

type TranscriptEntry = {
  entry: DataEntry
  directory: string
  generation: number
  rotating: boolean
  rotationGeneration: number
  needsAuthoritativeResync: boolean
  preserveNativePageOnResync: boolean
  resyncing: boolean
  resyncGeneration: number
  freshEntry?: DataEntry
  retryCount: number
  retryTimer?: ReturnType<typeof setTimeout>
  retireWhenDrained: boolean
  queue: QueuedTranscriptEvent[]
  onResynced?: (data: Data) => void
}

const MAX_ACTIVE_TRANSCRIPT_MESSAGES = 32
const MAX_TRANSCRIPT_MESSAGES = MESSAGE_WINDOW_PAGE_SIZE
// ponytail: overflow collapses all native deltas; one quiet, revision-stable fresh snapshot becomes authority.
const MAX_TRANSCRIPT_EVENT_QUEUE = 4096
const MAX_ROTATION_RESERVE = 64
const TRANSCRIPT_REPLAY_BUDGET_MS = 8
const MAX_TRANSCRIPT_REPLAY_CHUNK = 64
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
const unobservedCompactions = new Set<string>()
type CompactionDeltaContext = {
  instanceId: string
  directory: string
  onDeferred?: (data: Data) => void
  onResynced?: (data: Data) => void
  publication?: TranscriptPublication
}
const coalescedCompactionEvents = new WeakSet<object>()
const compactionDeltas = createCompactionDeltaBuffer<CompactionDeltaContext>((event, context) => {
  coalescedCompactionEvents.add(event)
  applyOpenCodeDataEvent(context.instanceId, context.directory, event, context.onDeferred, context.onResynced, false,
    context.publication ? { deferred: false, publication: context.publication } : undefined)
})
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
  instanceDataRevision(instanceId)[0]()
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
  const eventRevisions = new Map<string, number>()
  const instanceGeneration = getOpenCodeInstanceGeneration(instanceId)
  let disposed = false
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
                // Native terminal-tool reconciliation replaces its cache after
                // awaiting this response, without fencing intervening events.
                // Keep the live projection until one trailing read is current;
                // never merge an obsolete page into newer streaming messages.
                for (;;) {
                  if (disposed || getOpenCodeInstanceGeneration(instanceId) !== instanceGeneration) {
                    throw new Error("Stale read from disposed OpenCode projection")
                  }
                  // A current native page can already contain buffered text.
                  // Reduce it before taking read authority, never append it
                  // again to a page that was fetched after delta admission.
                  compactionDeltas.flush(instanceId, input.sessionID)
                  const snapshot = messageSnapshots.get(input.sessionID)
                  if (snapshot) return { data: [...snapshot].reverse(), cursor: {} }
                  const revision = eventRevisions.get(input.sessionID) ?? 0
                  const response = await (client.message.list as any)(input, options)
                  if (disposed || getOpenCodeInstanceGeneration(instanceId) !== instanceGeneration) {
                    throw new Error("Stale read from disposed OpenCode projection")
                  }
                  compactionDeltas.flush(instanceId, input.sessionID)
                  if ((eventRevisions.get(input.sessionID) ?? 0) !== revision) continue
                  return response
                }
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
      onError: (error) => log.warn("Failed to refresh OpenCode projection", { instanceId, error }),
    })
    const emit = (details: OpenCodeEvent) => {
      // Isolated fresh-entry resyncs already fence their entire transaction.
      // Only events applied to this reducer invalidate its own pending reads.
      const sessionId = eventSessionId(details)
      if (sessionId) eventRevisions.set(sessionId, (eventRevisions.get(sessionId) ?? 0) + 1)
      for (const listener of listeners) listener({ name: details.type, details })
    }
    return {
      data,
      emit(details: OpenCodeEvent) {
        emit(details)
      },
      fencePendingReads(sessionId: string) {
        eventRevisions.set(sessionId, (eventRevisions.get(sessionId) ?? 0) + 1)
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
      dispose() {
        disposed = true
        dispose()
      },
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
    preserveNativePageOnResync: false,
    resyncing: false,
    resyncGeneration: 0,
    retryCount: 0,
    retireWhenDrained: false,
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
    if (!isTranscriptCurrent(instanceId, sessionId, transcript) || transcript.entry !== fresh) return
    if (transcript.entry === fresh && !transcript.needsAuthoritativeResync) transcript.preserveNativePageOnResync = false
    retireDrainedTranscript(instanceId, sessionId, transcript)
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

async function drainTranscriptQueue(
  instanceId: string,
  sessionId: string,
  transcript: TranscriptEntry,
  entry: DataEntry,
  generation: number,
): Promise<boolean> {
  const current = () => isRotationCurrent(instanceId, sessionId, transcript, entry, generation)
  while (transcript.queue.length > 0) {
    if (!current()) return false
    const started = performance.now()
    let count = 0
    let needsRotation = false
    let publication: TranscriptPublication | undefined
    let events: OpenCodeEvent[] = []
    const publish = () => {
      if (publication && events.length) publication({ instanceId, sessionId, data: entry.data, events })
      events = []
      return current()
    }
    while (transcript.queue.length && count < MAX_TRANSCRIPT_REPLAY_CHUNK) {
      if (!current()) return false
      const queued = transcript.queue[0]
      // A different publication or an event-specific callback is an ordering
      // barrier: never run its side effects against a later event's state.
      if (queued.onApplied || queued.publication !== publication) {
        if (!publish()) return false
        publication = queued.publication
        if (count && performance.now() - started >= TRANSCRIPT_REPLAY_BUDGET_MS) break
        // Publication can admit more events or collapse the queue.
        if (transcript.queue[0] !== queued) return false
      }
      const messages = entry.data.session.message.list(sessionId)
      const runningCompactions = messages.filter((message) => message.type === "compaction" && message.status === "running").length
      if (eventMayAppendMessage(queued.event, runningCompactions) && messages.length >= MAX_TRANSCRIPT_MESSAGES) {
        needsRotation = true
        break
      }
      transcript.queue.shift()
      entry.emit(queued.event)
      if (!current()) return false
      if (queued.publication) events.push(queued.event)
      if (queued.onApplied) {
        queued.onApplied(entry.data)
        if (!current()) return false
        if (!publish()) return false
      }
      count += 1
      if (performance.now() - started >= TRANSCRIPT_REPLAY_BUDGET_MS) break
    }
    if (!publish()) return false
    if (!transcript.queue.length) return true
    // A real task boundary lets input/timers run, including hidden windows.
    // Microtasks (including SDK sync) do not provide that opportunity.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (!current()) return false
    if (needsRotation) return true
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
      if (!await drainTranscriptQueue(instanceId, sessionId, transcript, entry, generation)) return
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
    retireDrainedTranscript(instanceId, sessionId, transcript)
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
  skipUnobservedCompaction = false,
  admission?: OpenCodeDataEventAdmission,
): Data {
  if (admission) admission.deferred = false
  if (event.type === "server.connected") destroyOpenCodeData(instanceId)
  const primary = ensureData(instanceId, directory)
  // This native reducer owns transcript/inbox projection only. CodeNomad's
  // stores already reconcile catalogues, Shells and connection state. Even
  // with sync:false, feeding these events to createData starts HTTP refreshes.
  if (!/^(session|permission|form)\./.test(event.type)) return primary.data
  const sessionId = eventSessionId(event)
  const coalesced = coalescedCompactionEvents.delete(event)
  if (typeof sessionId === "string" && !coalesced) {
    if (event.type === "session.compaction.ended" || event.type === "session.compaction.failed"
      || event.type === "session.deleted" || event.type === "session.revert.committed") {
      // Terminal events replace summary text. Destructive events must not let
      // a delayed fragment resurrect a removed or invalidated compaction.
      compactionDeltas.cancel(instanceId, sessionId)
      unobservedCompactions.delete(messageRevisionKey(instanceId, sessionId))
    } else if (event.type !== "session.compaction.delta") {
      // A second start or another same-session event observes preceding text
      // in native order; unrelated sessions never force a flush.
      compactionDeltas.flush(instanceId, sessionId)
    }
  }
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
  if (typeof sessionId === "string" && !coalesced) {
    const key = messageRevisionKey(instanceId, sessionId)
    fullDataRevisions.set(key, (fullDataRevisions.get(key) ?? 0) + 1)
    if (eventAffectsMessages(event)) messageRevisions.set(key, (messageRevisions.get(key) ?? 0) + 1)
    if (event.type === "session.inbox.cancelled" || event.type === "session.revert.committed") bumpMutationRevision(key)
    if (skipUnobservedCompaction && event.type.startsWith("session.compaction.") && !transcriptEntries.has(key)) {
      // No native reducer/visible transcript is observing this session. The
      // next activation loads authoritative messages instead of storing deltas.
      if (event.type === "session.compaction.started") unobservedCompactions.add(key)
      if (event.type === "session.compaction.ended" || event.type === "session.compaction.failed") unobservedCompactions.delete(key)
      return primary.data
    }
  }
  const transcript = typeof sessionId === "string"
    ? ensureTranscript(instanceId, sessionId, directory)
    : undefined
  const entry = transcript?.entry ?? primary
  if (transcript && typeof sessionId === "string") {
    if (event.type === "session.compaction.started") unobservedCompactions.delete(messageRevisionKey(instanceId, sessionId))
    // A new execution must not inherit a preceding idle event's deferred cleanup.
    if (event.type === "session.execution.started" || eventMayAppendMessage(event)) transcript.retireWhenDrained = false
  }
  if (transcript && typeof sessionId === "string") {
    if (onResynced) transcript.onResynced = onResynced
    if (event.type === "session.compaction.delta" && unobservedCompactions.delete(messageRevisionKey(instanceId, sessionId))) {
      // Activation during a previously unobserved compaction has no start row
      // in the SDK reducer. Recover its exact native summary instead of making
      // up a start or appending a delta to a REST page that already includes it.
      transcript.preserveNativePageOnResync = true
      collapseTranscriptQueue(instanceId, sessionId, transcript)
      if (admission) admission.deferred = true
      return transcript.entry.data
    }
    if (transcript.needsAuthoritativeResync || transcript.resyncing) {
      collapseTranscriptQueue(instanceId, sessionId, transcript)
      if (admission) admission.deferred = true
      return transcript.entry.data
    }
    if (event.type === "session.compaction.delta" && !coalesced) {
      // Admission fences both CodeNomad and SDK reads immediately, even though
      // the reactive payload is reduced only once per interval.
      entry.fencePendingReads(sessionId)
      if (admission) admission.deferred = true
      compactionDeltas.push(instanceId, sessionId, event, { instanceId, directory, onDeferred, onResynced, publication: admission?.publication })
      return entry.data
    }
    if (transcript.rotating
      || (eventMayAppendMessage(event, transcript.entry.data.session.message.list(sessionId)
        .filter((message) => message.type === "compaction" && message.status === "running").length)
        && transcript.entry.data.session.message.list(sessionId).length >= MAX_TRANSCRIPT_MESSAGES)) {
      if (admission) admission.deferred = true
      enqueueTranscriptEvent(instanceId, sessionId, transcript, { event, onApplied: onDeferred, publication: admission?.publication })
      startTranscriptRotation(instanceId, sessionId, transcript)
      return transcript.entry.data
    }
  }
  entry.emit(event)
  if (coalesced) {
    onDeferred?.(entry.data)
    if (!transcript || (isTranscriptCurrent(instanceId, sessionId!, transcript) && transcript.entry === entry)) {
      admission?.publication?.({ instanceId, sessionId: sessionId!, data: entry.data, events: [event] })
    }
  }
  return entry.data
}

export function getOpenCodeMessageRevision(instanceId: string, sessionId: string): number {
  return messageRevisions.get(messageRevisionKey(instanceId, sessionId)) ?? 0
}

export function invalidateOpenCodeSessionContent(instanceId: string, sessionId: string): void {
  compactionDeltas.cancel(instanceId, sessionId)
  unobservedCompactions.delete(messageRevisionKey(instanceId, sessionId))
  const key = messageRevisionKey(instanceId, sessionId)
  bumpMutationRevision(key)
  messageRevisions.set(key, (messageRevisions.get(key) ?? 0) + 1)
  fullDataRevisions.set(key, (fullDataRevisions.get(key) ?? 0) + 1)
  entries.get(instanceId)?.data.session.message.invalidate(sessionId)
  const transcript = transcriptEntries.get(key)
  if (!transcript) return
  // Discard both pending rotations and the old SDK projection. Invalidating
  // just the visible page allows the next native event to restore stale parts.
  invalidateTranscript(transcript)
  transcript.entry.dispose()
  transcript.entry = createDataEntry(instanceId, transcript.directory)
  // The pruning handler (or the next session open) reloads the native UI page
  // together with its cursors. SDK reconciliation still repairs its independent
  // projection, but its 20-message seed cannot replace that 200-message page.
  transcript.preserveNativePageOnResync = true
  collapseTranscriptQueue(instanceId, sessionId, transcript)
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
  const transcript = transcriptEntries.get(messageRevisionKey(instanceId, sessionId))
  if (transcript && (transcript.entry.data !== data || transcript.needsAuthoritativeResync || transcript.resyncing)) return
  const source = data.session.message.list(sessionId).slice(-MESSAGE_WINDOW_PAGE_SIZE)
  const store = messageStoreBus.getOrCreate(instanceId)
  // During pruning reconciliation, only loadMessages owns native page
  // membership and pagination. The SDK seed may update resident messages, not
  // discard omitted history while retaining the larger page's cursor.
  if (transcript?.preserveNativePageOnResync && store.getMessageWindow(sessionId)) preserveOmitted = true
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

function retireDrainedTranscript(instanceId: string, sessionId: string, transcript: TranscriptEntry): void {
  if (!transcript.retireWhenDrained || !isTranscriptCurrent(instanceId, sessionId, transcript)
    || transcript.rotating || transcript.resyncing || transcript.needsAuthoritativeResync
    || transcript.retryTimer || transcript.queue.length) return
  destroyOpenCodeData(instanceId, sessionId)
}

export function finishOpenCodeDataEvent(instanceId: string, event: OpenCodeEvent): void {
  const sessionId = eventSessionId(event)
  if (sessionId === undefined) return
  if (event.type === "session.deleted") destroyOpenCodeData(instanceId, sessionId)
  if (event.type !== "session.idle") return
  const transcript = transcriptEntries.get(messageRevisionKey(instanceId, sessionId))
  if (!transcript) return
  // The caller has projected the synchronous page. Queued terminal updates and
  // overflow recovery must publish their final page before releasing its reducer.
  transcript.retireWhenDrained = true
  retireDrainedTranscript(instanceId, sessionId, transcript)
}

export function destroyOpenCodeData(instanceId: string, sessionId?: string): void {
  if (sessionId !== undefined) {
    compactionDeltas.cancel(instanceId, sessionId)
    unobservedCompactions.delete(messageRevisionKey(instanceId, sessionId))
    const key = messageRevisionKey(instanceId, sessionId)
    const transcript = transcriptEntries.get(key)
    if (transcript) {
      invalidateTranscript(transcript)
      transcript.entry.dispose()
      transcriptEntries.delete(key)
    }
    // Payload lifetime is shorter than request authority: a pending native page
    // must never see a pre-mutation revision again after idle/eviction. These
    // scalar fences are released on deletion or a fenced instance-generation reset.
    fullDataRevisions.delete(key)
    instanceDataRevision(instanceId)[1]((current) => current + 1)
    return
  }
  compactionDeltas.clear(instanceId)
  for (const key of unobservedCompactions) {
    if (key.startsWith(`${instanceId}\0`)) unobservedCompactions.delete(key)
  }
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
