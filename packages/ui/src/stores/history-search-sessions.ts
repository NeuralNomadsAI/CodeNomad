import { batch, createSignal, onCleanup, untrack } from "solid-js"
import { isSessionNotFoundError } from "@opencode/client"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { instances } from "./instances"
import { MESSAGE_STREAM_SCROLL_SCOPE, messageStoreBus } from "./message-v2/bus"
import { showSessionChatFor } from "./session-previews"
import { getAuthoritativelyDeletedSessionIdsForInstance, hydrateRestoredSessionChain, sessions, setActiveSessionFromList } from "./sessions"

export interface HistorySessionLabel {
  title: string
  directory?: string
}

const CONCURRENT_READS = 4

/**
 * Workspace search hits carry only native IDs. Each distinct session resolves
 * from the session store, or with one native read when it lies outside the
 * loaded catalog (older pages, collapsed subsessions). Display only: results
 * never add sessions to the list. Queued reads follow the visible results.
 */
export function createHistorySessionLabels(instanceId: () => string) {
  const [fetched, setFetched] = createSignal(new Map<string, HistorySessionLabel | null>())
  // Requested IDs stay until resolved; a transient failure is released for retry.
  const requested = new Set<string>()
  const queue: string[] = []
  let running = 0
  let owner = { instanceId: instanceId(), generation: getOpenCodeInstanceGeneration(instanceId()), controller: new AbortController() }

  function pump() {
    const current = owner
    while (running < CONCURRENT_READS && queue.length) {
      const sessionID = queue.shift()!
      running += 1
      void getRootClient(current.instanceId).session.get({ sessionID }, { signal: current.controller.signal })
        .then(session => ({ title: session.title ?? "", directory: session.location?.directory }), error => {
          // Only a missing session is unavailable; other failures retry on the next request.
          if (current === owner && !isSessionNotFoundError(error)) requested.delete(sessionID)
          return null
        })
        .then(label => {
          if (current === owner) setFetched(previous => new Map(previous).set(sessionID, label))
        })
        .finally(() => {
          if (current !== owner) return
          running -= 1
          pump()
        })
    }
  }

  /** Abandons pending reads; resolved labels are kept unless the connection changed. */
  function restart(clearLabels: boolean) {
    owner.controller.abort()
    owner = { instanceId: instanceId(), generation: getOpenCodeInstanceGeneration(instanceId()), controller: new AbortController() }
    queue.length = 0
    running = 0
    const labels = clearLabels ? new Map<string, HistorySessionLabel | null>() : fetched()
    for (const sessionId of [...requested]) if (!labels.has(sessionId)) requested.delete(sessionId)
    if (clearLabels) {
      requested.clear()
      setFetched(labels)
    }
  }

  onCleanup(() => owner.controller.abort())

  return {
    /** Queues reads for these sessions only; a reconnect discards older labels. */
    request(sessionIds: readonly string[]) {
      if (owner.instanceId !== instanceId() || owner.generation !== getOpenCodeInstanceGeneration(instanceId())) restart(true)
      untrack(() => {
        const wanted = new Set(sessionIds)
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          if (wanted.has(queue[index]!)) continue
          requested.delete(queue[index]!)
          queue.splice(index, 1)
        }
        const resident = sessions().get(owner.instanceId)
        for (const sessionId of wanted) {
          if (requested.has(sessionId) || resident?.has(sessionId)) continue
          requested.add(sessionId)
          queue.push(sessionId)
        }
      })
      pump()
    },
    /** Hidden results need no labels: stop reading them. */
    cancel() {
      restart(false)
    },
    /** `undefined` while unresolved, `null` when the session is unavailable. */
    get(sessionId: string): HistorySessionLabel | null | undefined {
      const resident = sessions().get(instanceId())?.get(sessionId)
      if (resident) return { title: resident.title ?? "", directory: resident.location?.directory }
      return fetched().get(sessionId)
    },
  }
}

/**
 * Opens a result's session at its message: hydrate only that session and its
 * parents, then let the destination transcript restore the anchor through its
 * normal bounded window load. `current` fences the caller's view.
 */
export async function openHistoryMatchSession(instanceId: string, sessionId: string, messageId: string, current: () => boolean): Promise<boolean> {
  const client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const admitted = () => current() && instances().get(instanceId)?.client === client
    && getOpenCodeInstanceGeneration(instanceId) === generation
    && !getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)
  if (!admitted()) return false
  await hydrateRestoredSessionChain(instanceId, [sessionId], undefined, admitted)
  if (!admitted() || !sessions().get(instanceId)?.has(sessionId)) return false
  messageStoreBus.getOrCreate(instanceId).setScrollSnapshot(sessionId, MESSAGE_STREAM_SCROLL_SCOPE,
    { scrollTop: 0, atBottom: false, anchorKey: messageId, anchorOffset: 0, followModeType: "escaped" })
  // A destination left on its browser preview would hide the transcript.
  batch(() => {
    setActiveSessionFromList(instanceId, sessionId)
    showSessionChatFor(sessionId, instances().get(instanceId)?.folder ?? "")
  })
  return true
}
