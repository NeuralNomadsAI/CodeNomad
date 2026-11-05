import type { Data } from "@opencode/client/solid"
import { getLogger } from "../lib/logger"

const log = getLogger("session")

/**
 * Frame-level coalescing for event-driven transcript projection.
 *
 * Native transcript events reduce synchronously and in order through the SDK
 * reducer (`stores/opencode-data.ts`); only their *projection* — copying the
 * reducer window into the message store, which re-renders the transcript — is
 * coalesced here to at most one pass per animation frame per session, always
 * reading the reducer's newest state. Projections never skip on reference
 * identity (the reducer mutates rows in place); `hydrateMessages` record reuse
 * remains what keeps an unchanged window cheap.
 *
 * The module stays free of store imports so the reducer's own lifetime
 * boundaries (`destroyOpenCodeData`) can cancel pending frames; every store
 * touch arrives through the gates the instance layer registers.
 */
export type TranscriptProjectionGates = {
  isActiveSession(instanceId: string, sessionId: string): boolean
  isLatestMessageWindow(instanceId: string, sessionId: string): boolean
  /** Inactive-session recovery: the next activation loads the page authoritatively. */
  invalidateInactiveLoadedSession(instanceId: string, sessionId: string): void
  /** Cost/token totals published after usage-affecting events. */
  onProjectedUsage(instanceId: string, sessionId: string): void
  /** Publishes a reduced page into the message store. */
  projectPage(instanceId: string, sessionId: string, data: Data, confirmPending: boolean): void
}

type PendingProjection = {
  instanceId: string
  sessionId: string
  data: Data
  confirmPending: boolean
  updateUsage: boolean
}

/** Hidden windows pause animation frames; this timer keeps projections bounded-stale instead. */
const HIDDEN_PROJECTION_INTERVAL_MS = 250

/**
 * An idle compositor can stop producing frames (a hidden or headless page with
 * nothing to draw), and a frame-aligned callback would then never run — a
 * scheduled projection could hang until the next paint. Every visible-window
 * schedule therefore also arms this short fallback; whichever wake wins, the
 * other is cancelled, so a live page still projects exactly once per frame.
 */
const FRAME_FALLBACK_MS = 32

let gates: TranscriptProjectionGates | undefined
const pending = new Map<string, PendingProjection>()
let cancelScheduledRun: (() => void) | undefined

export function setTranscriptProjectionGates(next: TranscriptProjectionGates): void {
  gates = next
}

function projectionKey(instanceId: string, sessionId: string): string {
  return `${instanceId}\u0000${sessionId}`
}

/** Defers one projection for a session to the current frame's end. Same-data
 * schedules merge (every admitted event then lands in one pass); a replaced
 * `data` reference (authoritative resync) simply wins with its own flags. */
export function scheduleTranscriptProjection(
  instanceId: string,
  sessionId: string,
  data: Data,
  options: { confirmPending?: boolean; updateUsage?: boolean } = {},
): void {
  if (!gates) return
  const key = projectionKey(instanceId, sessionId)
  const previous = pending.get(key)
  const merged = previous !== undefined && previous.data === data
  pending.set(key, {
    instanceId,
    sessionId,
    data,
    // The merged pass replaces a sequence of per-event projections, so the last
    // event decides confirmation (an `inbox.enqueued` tail must keep a parked
    // prompt's optimistic row pending), while usage updates accumulate.
    confirmPending: options.confirmPending ?? true,
    updateUsage: (merged ? previous.updateUsage : false) || Boolean(options.updateUsage),
  })
  requestScheduledRun()
}

/** Publishes pending projections now. Selection changes call this so a
 * page admitted under the previous selection still lands before its gates move;
 * a normal reducer retirement publishes its session's final page (including
 * usage obligations) before the reducer goes away, while resets, eviction and
 * destructive teardown stay cancel-only. An optional scope publishes only the
 * matching sessions and leaves the rest on their frame. */
export function flushTranscriptProjections(instanceId?: string, sessionId?: string): void {
  if (instanceId === undefined) {
    drain(true)
    return
  }
  const prefix = `${instanceId}\u0000`
  const matches = sessionId === undefined
    ? (key: string) => key.startsWith(prefix)
    : (key: string) => key === projectionKey(instanceId, sessionId)
  drain(true, matches)
}

/** Removes and returns a session's pending projection. A synchronous
 * publication takes its obligations (usage updates) over before dropping it. */
export function takeTranscriptProjection(instanceId: string, sessionId: string): PendingProjection | undefined {
  const key = projectionKey(instanceId, sessionId)
  const entry = pending.get(key)
  if (entry !== undefined) disarmIfEmpty(key)
  return entry
}

/** Drops pending projections for a session (or whole instance): destroyed
 * reducers must not be projected by a later frame into a resurrected store. */
export function cancelTranscriptProjections(instanceId: string, sessionId?: string): void {
  if (sessionId === undefined) {
    const prefix = `${instanceId}\u0000`
    for (const key of pending.keys()) {
      if (key.startsWith(prefix)) pending.delete(key)
    }
  } else {
    pending.delete(projectionKey(instanceId, sessionId))
  }
  if (!pending.size) disarm()
}

function disarmIfEmpty(removedKey: string): void {
  pending.delete(removedKey)
  if (!pending.size) disarm()
}

function disarm(): void {
  if (cancelScheduledRun) {
    cancelScheduledRun()
    cancelScheduledRun = undefined
  }
}

function drain(bypassActiveGate: boolean, matches?: (key: string) => boolean): void {
  if (!pending.size || !gates) {
    disarm()
    return
  }
  const keys = matches === undefined ? [...pending.keys()] : [...pending.keys()].filter(matches)
  if (!keys.length) return
  const entries = keys.map(key => pending.get(key)!)
  for (const key of keys) pending.delete(key)
  // A scoped drain leaves the other sessions on their already armed wake:
  // re-arming it would let repeated retirements elsewhere postpone them.
  if (!pending.size) disarm()
  for (const entry of entries) {
    try {
      applyProjection(entry, bypassActiveGate)
    } catch (error) {
      log.error("Failed to project coalesced transcript page", {
        instanceId: entry.instanceId, sessionId: entry.sessionId, error,
      })
    }
  }
  // Projections scheduled while draining need a wake (a no-op when one is armed).
  if (pending.size) requestScheduledRun()
}

function applyProjection(entry: PendingProjection, bypassActiveGate: boolean): void {
  const gate = gates
  if (!gate) return
  if (!bypassActiveGate && !gate.isActiveSession(entry.instanceId, entry.sessionId)) {
    // Admitted under an older selection: the next activation reads the page
    // authoritatively instead of trusting a stale display window.
    gate.invalidateInactiveLoadedSession(entry.instanceId, entry.sessionId)
    return
  }
  if (!gate.isLatestMessageWindow(entry.instanceId, entry.sessionId)) return
  gate.projectPage(entry.instanceId, entry.sessionId, entry.data, entry.confirmPending)
  if (entry.updateUsage) gate.onProjectedUsage(entry.instanceId, entry.sessionId)
}

function requestScheduledRun(): void {
  if (cancelScheduledRun) return
  if (typeof document !== "undefined" && document.hidden) {
    const timer = setTimeout(() => drain(false), HIDDEN_PROJECTION_INTERVAL_MS)
    cancelScheduledRun = () => clearTimeout(timer)
    return
  }
  if (typeof requestAnimationFrame === "function") {
    const cancelFrame = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : () => {}
    let frame: number | undefined
    let fallback: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      if (frame !== undefined) cancelFrame(frame)
      if (fallback !== undefined) clearTimeout(fallback)
      cancelScheduledRun = undefined
      drain(false)
    }
    const cancel = () => {
      if (settled) return
      settled = true
      if (frame !== undefined) cancelFrame(frame)
      if (fallback !== undefined) clearTimeout(fallback)
      cancelScheduledRun = undefined
    }
    frame = requestAnimationFrame(settle)
    fallback = setTimeout(settle, FRAME_FALLBACK_MS)
    cancelScheduledRun = cancel
    return
  }
  // No frame scheduler exists (server-side/unit contexts): there is no frame to
  // coalesce onto, so projections keep their synchronous behavior.
  drain(false)
}

if (typeof document !== "undefined") {
  // Flushing on visibility transitions keeps a hidden window from holding an
  // unprojected page (animation frames pause there) and a repainted window
  // from starting stale.
  document.addEventListener("visibilitychange", () => flushTranscriptProjections())
}
