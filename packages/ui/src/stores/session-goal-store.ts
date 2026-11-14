import { createSignal, untrack } from "solid-js"
import { goalChangedSchema, goalStateSchema, type SessionGoalResponse } from "../../../server/src/opencode/goal-contract"

/** A Session's `/goal` as last heard: `loading` until the first answer. */
export type SessionGoalSnapshot = { status: "loading" } | SessionGoalResponse

const LOADING: SessionGoalSnapshot = { status: "loading" }

interface Entry {
  demand: number
  /** Bumped by every published change; a read dispatched before it is older. */
  version: number
  reading?: { dirty: boolean; promise: Promise<void>; controller: AbortController }
}

/**
 * Goals of the Sessions the Status tab shows, keyed by instance and Session.
 * Demand (a mounted goal line) reads; `changed` events and the line's own
 * commands keep it current, reconnects re-read what is shown. One read runs per
 * demanded Session with at most one trailing follow-up, and an answer is
 * published only when no change was heard since it was requested. Releasing the
 * last demand aborts the Session's queued or running read, so switching sessions
 * never queues reads for hidden ones; the next demand reads again. A failed read
 * keeps the last goal shown. Nothing reads on a timer.
 */
export function createSessionGoalStore(read: (instanceId: string, sessionId: string, signal: AbortSignal) => Promise<SessionGoalResponse>) {
  const [snapshots, setSnapshots] = createSignal<ReadonlyMap<string, SessionGoalSnapshot>>(new Map())
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set())
  const entries = new Map<string, Entry>()
  const key = (instanceId: string, sessionId: string) => `${instanceId}\0${sessionId}`
  const publish = (stateKey: string, snapshot: SessionGoalSnapshot) => setSnapshots(current => new Map(current).set(stateKey, snapshot))
  const cancel = (entry: Entry | undefined) => {
    const reading = entry?.reading
    if (!reading) return
    entry.reading = undefined
    reading.controller.abort()
  }

  const refresh = (instanceId: string, sessionId: string): Promise<void> => {
    const stateKey = key(instanceId, sessionId)
    const entry = entries.get(stateKey)
    if (!entry || entry.demand === 0) return Promise.resolve()
    if (entry.reading) {
      entry.reading.dirty = true
      return entry.reading.promise
    }
    const reading = { dirty: false, promise: Promise.resolve(), controller: new AbortController() }
    const { signal } = reading.controller
    entry.reading = reading
    reading.promise = (async () => {
      try {
        do {
          reading.dirty = false
          const version = entry.version
          const answer = await read(instanceId, sessionId, signal).catch((): SessionGoalResponse => ({ status: "unavailable" }))
          if (signal.aborted) return
          if (entries.get(stateKey) !== entry || entry.version !== version) continue
          const shown = untrack(snapshots).get(stateKey)
          if (answer?.status === "goal" || answer?.status === "unsupported") publish(stateKey, answer)
          else if (shown?.status !== "goal") publish(stateKey, { status: "unavailable" })
        } while (reading.dirty && entries.get(stateKey) === entry && entry.demand > 0)
      } finally {
        if (entry.reading === reading) entry.reading = undefined
      }
    })()
    return reading.promise
  }

  return {
    state(instanceId: string, sessionId: string): SessionGoalSnapshot {
      return snapshots().get(key(instanceId, sessionId)) ?? LOADING
    },
    busy(instanceId: string, sessionId: string): boolean {
      return busy().has(key(instanceId, sessionId))
    },
    /** Reads now and tracks the Session until the returned release, whose last call aborts its read. */
    demand(instanceId: string, sessionId: string): () => void {
      const stateKey = key(instanceId, sessionId)
      let entry = entries.get(stateKey)
      if (!entry) entries.set(stateKey, entry = { demand: 0, version: 0 })
      const tracked = entry
      tracked.demand += 1
      void refresh(instanceId, sessionId)
      let released = false
      return () => {
        if (released) return
        released = true
        tracked.demand -= 1
        if (tracked.demand === 0) cancel(tracked)
      }
    },
    refresh,
    /** Re-reads the demanded Sessions (of one instance), after a reconnect missed changes. */
    refreshDemanded(instanceId?: string): Promise<void> {
      return Promise.all(Array.from(entries, ([stateKey, entry]) => {
        const [owner, sessionId] = stateKey.split("\0") as [string, string]
        return entry.demand > 0 && (instanceId === undefined || owner === instanceId) ? refresh(owner, sessionId) : undefined
      })).then(() => undefined)
    },
    /** `rpc.opencode.goal.changed`: the new value of a tracked Session's goal. */
    applyChanged(instanceId: string, data: unknown): void {
      const sessionId = goalChangedSchema.shape.sessionID.safeParse((data as { sessionID?: unknown } | null)?.sessionID)
      if (!sessionId.success) return
      const stateKey = key(instanceId, sessionId.data)
      const entry = entries.get(stateKey)
      if (!entry) return
      const goal = goalStateSchema.nullable().safeParse((data as { goal?: unknown }).goal)
      // A change this client cannot read is still a change: ask for the value
      // (a hidden Session reads on its next demand).
      if (!goal.success) return void refresh(instanceId, sessionId.data)
      entry.version += 1
      publish(stateKey, { status: "goal", goal: goal.data })
    },
    forget(instanceId: string, sessionId: string): void {
      const stateKey = key(instanceId, sessionId)
      cancel(entries.get(stateKey))
      entries.delete(stateKey)
      setSnapshots(current => {
        if (!current.has(stateKey)) return current
        const next = new Map(current)
        next.delete(stateKey)
        return next
      })
    },
    clearInstance(instanceId: string): void {
      const prefix = `${instanceId}\0`
      for (const [stateKey, entry] of [...entries]) {
        if (!stateKey.startsWith(prefix)) continue
        cancel(entry)
        entries.delete(stateKey)
      }
      setSnapshots(current => new Map([...current].filter(([stateKey]) => !stateKey.startsWith(prefix))))
    },
    /** Runs one command for the Session (refusing a second meanwhile), then reads its outcome while it is shown. */
    async run(instanceId: string, sessionId: string, command: () => Promise<void>): Promise<void> {
      const stateKey = key(instanceId, sessionId)
      if (untrack(busy).has(stateKey)) return
      setBusy(current => new Set(current).add(stateKey))
      try {
        await command()
      } finally {
        setBusy(current => {
          const next = new Set(current)
          next.delete(stateKey)
          return next
        })
        void refresh(instanceId, sessionId)
      }
    },
  }
}

export type SessionGoalStore = ReturnType<typeof createSessionGoalStore>
