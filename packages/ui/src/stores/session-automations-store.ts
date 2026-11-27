import { createSignal, untrack } from "solid-js"
import { parseInstanceKey } from "../lib/backend-identity"
import { HttpResponseError } from "../lib/retryable-file-search"
import type { SessionAutomation, SessionAutomationsResponse } from "../../../server/src/opencode/automation-contract"

/** Returns genuine upstream automation errors as-is while keeping fixed local route errors localized. */
export function formatAutomationMutationError(error: unknown, fallback: string): string {
  if (error instanceof HttpResponseError && error.body && typeof error.body === "object") {
    const body = error.body as { status?: unknown; error?: unknown; upstream?: unknown }
    if (body.status === "error") {
      return body.upstream === true && typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : fallback
    }
  }
  return fallback
}

/** A Session's `/automation` list as last heard: `loading` until the first answer. */
export type SessionAutomationsSnapshot = { status: "loading" } | SessionAutomationsResponse

const LOADING: SessionAutomationsSnapshot = { status: "loading" }
const DUE_GRACE_MS = 1_500
const OVERDUE_BACKOFF_MS = 15_000
const EVENT_TRIGGER_POLL_MS = 15_000
const SHELL_EXIT_SETTLE_MS = 1_500
const MAX_DUE_DELAY_MS = 60 * 60 * 1000

interface Entry {
  demand: number
  version: number
  authority?: AbortSignal
  releaseAuthority?: () => void
  reading?: { dirty: boolean; promise: Promise<void>; controller: AbortController }
  dueTimer?: ReturnType<typeof setTimeout>
  shellFollowUpTimer?: ReturnType<typeof setTimeout>
  overdueChecks: number
}

function shellAutomationSignature(automations: readonly SessionAutomation[]): string | null {
  const rows = automations.filter(item => item.action.type === "shell")
  if (rows.length === 0) return null
  return rows.map(item => `${item.id}\0${item.status}\0${item.runCount}\0${item.updatedAt}\0${item.lastOutcome ?? ""}\0${item.lastOutput ?? ""}`).join("\n")
}

function inspectActiveDueTimes(automations: readonly SessionAutomation[], nowMs: number): {
  hasOverdue: boolean
  nextFutureDue: number | null
} {
  let hasOverdue = false
  let nextFutureDue: number | null = null
  for (const item of automations) {
    if (item.status !== "active" || typeof item.nextDueAt !== "number" || !Number.isFinite(item.nextDueAt)) continue
    if (item.nextDueAt <= nowMs) {
      hasOverdue = true
    } else if (nextFutureDue === null || item.nextDueAt < nextFutureDue) {
      nextFutureDue = item.nextDueAt
    }
  }
  return { hasOverdue, nextFutureDue }
}

/**
 * Automations of the Sessions the Status tab shows, keyed by instance and Session.
 * Demand (a mounted block) reads; execution completion, reconnects and the block's
 * own actions keep it current. While demanded and an active automation has a
 * `nextDueAt`, one targeted timer re-reads right after that due instant (with
 * bounded backoff if still overdue, zero polling when hidden or idle).
 */
export function createSessionAutomationsStore(
  read: (instanceId: string, sessionId: string, signal: AbortSignal) => Promise<SessionAutomationsResponse>,
  options: {
    signal?: (instanceId: string) => AbortSignal | undefined
    now?: () => number
  } = {},
) {
  const [snapshots, setSnapshots] = createSignal<ReadonlyMap<string, SessionAutomationsSnapshot>>(new Map())
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set())
  const entries = new Map<string, Entry>()
  const now = () => options.now?.() ?? Date.now()
  const key = (instanceId: string, sessionId: string) => `${instanceId}\0${sessionId}`
  const busyKey = (instanceId: string, sessionId: string, automationId: string) => `${instanceId}\0${sessionId}\0${automationId}`
  const publish = (stateKey: string, snapshot: SessionAutomationsSnapshot) =>
    setSnapshots(current => new Map(current).set(stateKey, snapshot))
  const dropSnapshot = (stateKey: string) =>
    setSnapshots(current => {
      if (!current.has(stateKey)) return current
      const next = new Map(current)
      next.delete(stateKey)
      return next
    })

  const clearDueTimer = (entry: Entry | undefined) => {
    if (!entry?.dueTimer) return
    clearTimeout(entry.dueTimer)
    entry.dueTimer = undefined
  }

  const clearShellFollowUp = (entry: Entry | undefined) => {
    if (!entry?.shellFollowUpTimer) return
    clearTimeout(entry.shellFollowUpTimer)
    entry.shellFollowUpTimer = undefined
  }

  const cancel = (entry: Entry | undefined) => {
    clearDueTimer(entry)
    clearShellFollowUp(entry)
    const reading = entry?.reading
    if (!reading) return
    entry.reading = undefined
    reading.controller.abort()
  }

  const scheduleDueRefresh = (
    instanceId: string,
    sessionId: string,
    entry: Entry,
    automations: readonly SessionAutomation[],
    retryFailure = false,
  ) => {
    clearDueTimer(entry)
    if (entry.demand === 0 || options.signal?.(instanceId)?.aborted) return
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return
    const nowMs = now()
    const { hasOverdue, nextFutureDue } = inspectActiveDueTimes(automations, nowMs)
    const futureDelay = nextFutureDue !== null
      ? Math.min(nextFutureDue - nowMs + DUE_GRACE_MS, MAX_DUE_DELAY_MS)
      : null
    // Prompt/shell event triggers refresh on execution terminal / shell.exited events; only code-action event triggers need bounded polling.
    const hasActiveCodeEventTrigger = automations.some(item =>
      item.status === "active" && item.trigger.type === "event" && item.action.type === "code")
    const hasPendingShellResult = automations.some(item =>
      item.action.type === "shell" && item.status === "done" && item.lastOutput === undefined && item.lastOutcome === undefined)
    if (!retryFailure && futureDelay === null && !hasOverdue && !hasActiveCodeEventTrigger && !hasPendingShellResult) {
      entry.overdueChecks = 0
      return
    }
    let delayMs: number
    if (retryFailure) {
      // Bound retries if a read fails transiently, while keeping the next known future deadline scheduled.
      if (entry.overdueChecks < 3) {
        entry.overdueChecks += 1
        const backoff = OVERDUE_BACKOFF_MS * entry.overdueChecks
        delayMs = futureDelay !== null ? Math.min(backoff, futureDelay) : backoff
      } else if (futureDelay !== null) {
        delayMs = futureDelay
      } else {
        return
      }
    } else if (hasActiveCodeEventTrigger) {
      entry.overdueChecks = 0
      delayMs = futureDelay !== null ? Math.min(EVENT_TRIGGER_POLL_MS, futureDelay) : EVENT_TRIGGER_POLL_MS
    } else if (hasOverdue || hasPendingShellResult) {
      // Bound overdue/pending-shell retries, but keep the next future deadline scheduled once retries are exhausted.
      if (entry.overdueChecks < 3) {
        entry.overdueChecks += 1
        const backoff = OVERDUE_BACKOFF_MS * entry.overdueChecks
        delayMs = futureDelay !== null ? Math.min(backoff, futureDelay) : backoff
      } else if (futureDelay !== null) {
        delayMs = futureDelay
      } else {
        return
      }
    } else if (futureDelay !== null) {
      entry.overdueChecks = 0
      delayMs = futureDelay
    } else {
      return
    }
    entry.dueTimer = setTimeout(() => {
      entry.dueTimer = undefined
      if (entry.demand > 0 && entries.get(key(instanceId, sessionId)) === entry) {
        void refresh(instanceId, sessionId)
      }
    }, delayMs)
  }

  const refresh = (instanceId: string, sessionId: string): Promise<void> => {
    const stateKey = key(instanceId, sessionId)
    const entry = entries.get(stateKey)
    if (!entry || entry.demand === 0) return Promise.resolve()
    const authority = options.signal?.(instanceId)
    if (entry.authority !== authority || !entry.releaseAuthority) {
      const switched = entry.authority !== undefined && entry.authority !== authority
      entry.releaseAuthority?.()
      cancel(entry)
      if (switched) {
        entry.version += 1
        entry.overdueChecks = 0
        dropSnapshot(stateKey)
      }
      entry.authority = authority
      const abort = () => {
        if (entry.authority === authority) {
          entry.version++
          cancel(entry)
          dropSnapshot(stateKey)
        }
      }
      authority?.addEventListener("abort", abort, { once: true })
      entry.releaseAuthority = () => { authority?.removeEventListener("abort", abort); entry.releaseAuthority = undefined }
    }
    if (authority?.aborted) {
      dropSnapshot(stateKey)
      return Promise.resolve()
    }
    if (entry.reading) {
      entry.reading.dirty = true
      return entry.reading.promise
    }
    const reading = { dirty: false, promise: Promise.resolve(), controller: new AbortController() }
    const signal = authority ? AbortSignal.any([authority, reading.controller.signal]) : reading.controller.signal
    entry.reading = reading
    reading.promise = (async () => {
      try {
        do {
          if (signal.aborted) return
          reading.dirty = false
          const version = entry.version
          const answer = await read(instanceId, sessionId, signal).catch((): SessionAutomationsResponse => ({ status: "unavailable" }))
          if (signal.aborted) return
          if (entries.get(stateKey) !== entry || entry.version !== version) continue
          const shown = untrack(snapshots).get(stateKey)
          if (answer?.status === "ok" && Array.isArray(answer.automations)) {
            publish(stateKey, answer)
            scheduleDueRefresh(instanceId, sessionId, entry, answer.automations)
          } else if (answer?.status === "unsupported") {
            clearDueTimer(entry)
            publish(stateKey, answer)
          } else if (shown?.status !== "ok") {
            clearDueTimer(entry)
            publish(stateKey, { status: "unavailable" })
          } else {
            scheduleDueRefresh(instanceId, sessionId, entry, shown.automations, true)
          }
        } while (reading.dirty && entries.get(stateKey) === entry && entry.demand > 0)
      } finally {
        if (entry.reading === reading) entry.reading = undefined
      }
    })()
    return reading.promise
  }

  return {
    state(instanceId: string, sessionId: string): SessionAutomationsSnapshot {
      return snapshots().get(key(instanceId, sessionId)) ?? LOADING
    },
    busy(instanceId: string, sessionId: string, automationId: string): boolean {
      return busy().has(busyKey(instanceId, sessionId, automationId))
    },
    demand(instanceId: string, sessionId: string): () => void {
      const stateKey = key(instanceId, sessionId)
      let entry = entries.get(stateKey)
      if (!entry) entries.set(stateKey, entry = { demand: 0, version: 0, overdueChecks: 0 })
      const tracked = entry
      tracked.demand += 1
      tracked.overdueChecks = 0
      void refresh(instanceId, sessionId)
      let released = false
      return () => {
        if (released) return
        released = true
        tracked.demand -= 1
        if (tracked.demand === 0) {
          cancel(tracked)
          tracked.releaseAuthority?.()
          if (entries.get(stateKey) === tracked) entries.delete(stateKey)
          // Drop snapshots on last release so prompt/code/state payloads are not retained when hidden or detached.
          dropSnapshot(stateKey)
        }
      }
    },
    refresh,
    refreshDemanded(instanceId?: string, backendId?: string): Promise<void> {
      return Promise.all(Array.from(entries, ([stateKey, entry]) => {
        const [owner, sessionId] = stateKey.split("\0") as [string, string]
        return entry.demand > 0 && (instanceId === undefined || owner === instanceId)
          && (backendId === undefined || parseInstanceKey(owner).backendId === backendId)
          ? (entry.overdueChecks = 0, refresh(owner, sessionId))
          : undefined
      })).then(() => undefined)
    },
    /** Refreshes demanded Sessions with shell automations on `shell.exited`, with one short follow-up if persistence lags the exit event. */
    noteShellExited(instanceId: string): Promise<void> {
      return Promise.all(Array.from(entries, ([stateKey, entry]) => {
        const [owner, sessionId] = stateKey.split("\0") as [string, string]
        if (entry.demand === 0 || owner !== instanceId) return undefined
        const shown = untrack(snapshots).get(stateKey)
        if (shown?.status !== "ok") return undefined
        const before = shellAutomationSignature(shown.automations)
        if (before === null) return undefined
        clearShellFollowUp(entry)
        entry.overdueChecks = 0
        return refresh(owner, sessionId).then(() => {
          if (entry.demand === 0 || entries.get(stateKey) !== entry || options.signal?.(owner)?.aborted) return
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return
          const after = untrack(snapshots).get(stateKey)
          if (after?.status === "ok" && shellAutomationSignature(after.automations) === before) {
            clearShellFollowUp(entry)
            entry.shellFollowUpTimer = setTimeout(() => {
              entry.shellFollowUpTimer = undefined
              if (entry.demand > 0 && entries.get(stateKey) === entry && !options.signal?.(owner)?.aborted) {
                void refresh(owner, sessionId)
              }
            }, SHELL_EXIT_SETTLE_MS)
          }
        })
      })).then(() => undefined)
    },
    forget(instanceId: string, sessionId: string): void {
      const stateKey = key(instanceId, sessionId)
      cancel(entries.get(stateKey))
      entries.get(stateKey)?.releaseAuthority?.()
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
        entry.releaseAuthority?.()
        entries.delete(stateKey)
      }
      setSnapshots(current => new Map([...current].filter(([stateKey]) => !stateKey.startsWith(prefix))))
    },
    /** Runs one action for one automation (refusing a concurrent action on the same automation), applies any confirmed update while fencing earlier reads, and refreshes before unlocking. */
    async run(
      instanceId: string,
      sessionId: string,
      automationId: string,
      action: () => Promise<((items: readonly SessionAutomation[]) => SessionAutomation[]) | void>,
    ): Promise<void> {
      const authority = options.signal?.(instanceId)
      if (authority?.aborted) return
      const idKey = busyKey(instanceId, sessionId, automationId)
      if (untrack(busy).has(idKey)) return
      setBusy(current => new Set(current).add(idKey))
      try {
        const patch = await action()
        if (patch && !authority?.aborted && authority === options.signal?.(instanceId)) {
          const stateKey = key(instanceId, sessionId)
          const entry = entries.get(stateKey)
          if (entry) {
            entry.version += 1
            if (entry.reading) entry.reading.dirty = true
          }
          const shown = untrack(snapshots).get(stateKey)
          if (shown?.status === "ok") {
            const next = patch(shown.automations)
            publish(stateKey, { status: "ok", automations: next })
            if (entry) {
              entry.overdueChecks = 0
              scheduleDueRefresh(instanceId, sessionId, entry, next)
            }
          }
        }
      } finally {
        try {
          if (!authority?.aborted && authority === options.signal?.(instanceId)) {
            const entry = entries.get(key(instanceId, sessionId))
            if (entry) entry.overdueChecks = 0
            await refresh(instanceId, sessionId)
          }
        } finally {
          setBusy(current => {
            const next = new Set(current)
            next.delete(idKey)
            return next
          })
        }
      }
    },
  }
}

export type SessionAutomationsStore = ReturnType<typeof createSessionAutomationsStore>
