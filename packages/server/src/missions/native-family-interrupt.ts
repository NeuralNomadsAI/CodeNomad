import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { readNativeControlFamily, type NativeControlFamily } from "./native-session-family"

export const MAX_REPORTED_DESCENDANTS = 64
const PASSES = 3
const CONCURRENCY = 8

/** Bounded per-target summary of the recursive part of a Pause/Stop. It is
 * native interrupt/cancel evidence, never proof that every sub-agent stopped
 * unless `complete` is true. */
export interface MissionDescendantControl {
  /** Descendants enumerated under the target (the target itself excluded). */
  observed: number
  /** Native interrupts that reported `interrupted: true`. */
  interrupted: number
  /** Queued inbox items cancelled in descendants (Stop only). */
  cancelled: number
  /** Failed cancellations or sessions still active after the bounded passes. */
  unconfirmed: number
  /** Whole family enumerated and nothing left unconfirmed. */
  complete: boolean
  /** First interrupted descendant sessions, deepest first. */
  sessions: string[]
}

interface Options {
  client: OpenCodeClient
  root: SessionInfo
  action: "pause" | "stop"
  signal: AbortSignal
  /** Synchronous currentness fence before every native mutation. */
  current: () => void
  /** Full authority/target/operation recheck between levels. */
  checkpoint: () => Promise<void>
  deadline: number
  settleMs?: number
}

/** Interrupts every active native descendant of `root`, deepest level first,
 * so a child's completion cannot re-wake a parent that is already stopped.
 * Native subagent jobs deliver their (cancelled) result to the parent inbox
 * asynchronously and a still-running parent may launch new subagents, so every
 * pass re-reads the family and its activity, and a final read confirms quiet.
 * Stop also cancels queued descendant inbox items; Pause leaves them parked
 * behind `resume: false` until an explicit Play. The root is left to the caller.
 * Native read/interrupt failures and the deadline yield an honest partial
 * result instead of throwing, so the caller can still interrupt the root;
 * only abort, currentness and checkpoint failures propagate. */
export async function interruptNativeMissionFamily(options: Options): Promise<{ family: NativeControlFamily; descendants: MissionDescendantControl }> {
  const { client, root, signal, current } = options
  // Bound in-flight native calls too: an unanswered call past the deadline is unconfirmed.
  const walk = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, options.deadline - Date.now()))])
  const native = { ...options, signal: walk }
  const interrupted: string[] = [], observed = new Set<string>(), drained = new Set<string>(), failedCancels = new Set<string>()
  let cancelled = 0, expired = false, unknown = false, residual: string[] = []
  let family: NativeControlFamily = { members: new Map([[root.id, { session: root, depth: 0 }]]), complete: false }
  for (let pass = 0; pass <= PASSES; pass++) {
    let active: Readonly<Record<string, unknown>>
    try {
      family = await readNativeControlFamily(client, root, walk, { assertCurrent: current, deadline: options.deadline })
      active = await readActive(native)
    } catch { signal.throwIfAborted(); unknown = true; break }
    const order = deepestFirst(family, root.id)
    for (const id of order.flat()) observed.add(id)
    residual = order.flat().filter(id => active[id])
    // Stop drains every descendant inbox once, including idle and newly seen
    // ones, and again whenever a session is observed active.
    const drain = new Set(options.action === "stop" ? order.flat().filter(id => !drained.has(id) || active[id]) : [])
    if (!residual.length && !drain.size) break
    if (pass === PASSES) break
    for (const level of order) {
      if (Date.now() > options.deadline) { expired = true; break }
      await options.checkpoint()
      const targets = level.filter(id => active[id] || drain.has(id))
      if (!await bounded(targets, options.deadline, async id => {
        if (active[id]) {
          current()
          try {
            const result = await client.session.interrupt({ sessionID: id, resume: false }, { signal: walk })
            if (result?.interrupted === true && !interrupted.includes(id)) interrupted.push(id)
          } catch { signal.throwIfAborted() }
        }
        if (drain.has(id)) {
          drained.add(id)
          // Never `+= await`: concurrent workers would lose updates.
          try { const count = await cancelQueued(native, id, () => true); cancelled += count; failedCancels.delete(id) }
          catch { signal.throwIfAborted(); failedCancels.add(id) }
        }
      })) expired = true
      current()
      if (expired) break
    }
    if (expired) break
    try { await sleep(options.settleMs ?? 250, walk) } catch { signal.throwIfAborted(); expired = true; break }
  }
  const unconfirmed = new Set([...failedCancels, ...residual]).size
  return { family, descendants: {
    observed: observed.size, interrupted: interrupted.length, cancelled, unconfirmed,
    complete: family.complete && !expired && !unknown && unconfirmed === 0, sessions: interrupted.slice(0, MAX_REPORTED_DESCENDANTS),
  } }
}

/** Post-root recheck. The root ran until its own interrupt, so a descendant still
 * (or newly) active was missed or launched meanwhile: with `interrupt`, stop it
 * deepest first; otherwise this is the verification read, and a family is only
 * confirmed stopped when it observes the family whole and quiet. */
export async function recheckNativeMissionFamily(options: Options, descendants: MissionDescendantControl,
  interrupt: boolean): Promise<MissionDescendantControl> {
  const { client, root, signal, current } = options
  const walk = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, options.deadline - Date.now()))])
  try {
    const family = await readNativeControlFamily(client, root, walk, { assertCurrent: current, deadline: options.deadline })
    const active = await readActive({ ...options, signal: walk })
    const residual = deepestFirst(family, root.id).flat().filter(id => active[id])
    const sessions = [...descendants.sessions]
    let interrupted = descendants.interrupted
    if (interrupt && residual.length) {
      await options.checkpoint()
      for (const id of residual) {
        current()
        try {
          if ((await client.session.interrupt({ sessionID: id, resume: false }, { signal: walk }))?.interrupted === true) {
            interrupted++
            if (sessions.length < MAX_REPORTED_DESCENDANTS && !sessions.includes(id)) sessions.push(id)
          }
        } catch { signal.throwIfAborted() }
      }
    }
    return { ...descendants, sessions, interrupted, observed: Math.max(descendants.observed, family.members.size - 1),
      // A lower bound of the distinct union: the passes may already count these sessions.
      ...(interrupt ? {} : { unconfirmed: Math.max(descendants.unconfirmed, residual.length) }),
      complete: descendants.complete && family.complete && (interrupt || !residual.length) }
  } catch {
    signal.throwIfAborted()
    return { ...descendants, complete: false }
  }
}

function deepestFirst(family: NativeControlFamily, rootID: string): string[][] {
  const levels = new Map<number, string[]>()
  for (const [id, { depth }] of family.members) if (id !== rootID) levels.set(depth, [...(levels.get(depth) ?? []), id])
  return [...levels.keys()].sort((left, right) => right - left).map(depth => levels.get(depth)!)
}

/** After the root's own interrupt, late subagent deliveries may re-wake it.
 * Re-interrupt boundedly; on Stop also cancel the matching queued items. */
export async function settleInterruptedRoot(options: Omit<Options, "deadline"> & {
  cancel?: (item: InboxItem) => boolean
  onCancelled?: (inboxID: string) => void
}): Promise<boolean> {
  const { client, root, signal, current } = options
  let failed = false
  for (let pass = 0; pass < PASSES; pass++) {
    await sleep(options.settleMs ?? 250, signal)
    await options.checkpoint()
    let changed = false
    if (options.cancel) {
      try { changed = await cancelQueued(options, root.id, options.cancel, options.onCancelled) > 0 }
      catch { signal.throwIfAborted(); failed = true }
    }
    const active = await readActive(options)
    if (active[root.id]) {
      current()
      await client.session.interrupt({ sessionID: root.id, resume: false }, { signal })
      changed = true
    }
    if (!changed) return !failed
  }
  return !failed && !(await readActive(options))[root.id]
}

export type NativeInboxItem = Awaited<ReturnType<OpenCodeClient["session"]["inbox"]["list"]>>[number]
type InboxItem = NativeInboxItem

async function cancelQueued(options: Pick<Options, "client" | "signal" | "current">, sessionID: string,
  matches: (item: InboxItem) => boolean, onCancelled?: (inboxID: string) => void): Promise<number> {
  const { client, signal, current } = options
  const inbox = await client.session.inbox.list({ sessionID }, { signal })
  current()
  let count = 0
  for (const item of inbox.slice(0, 128)) {
    if ((item.type !== "user" && item.type !== "synthetic") || !matches(item)) continue
    current()
    try { await client.session.inbox.cancel({ sessionID, inboxID: item.id }, { signal }) }
    catch (error) {
      signal.throwIfAborted()
      const pending = await client.session.inbox.list({ sessionID }, { signal })
      if (pending.some(entry => entry.id === item.id)) throw error
    }
    current()
    onCancelled?.(item.id)
    count++
  }
  if (inbox.length > 128) throw new Error("Incomplete native inbox observation")
  return count
}

async function readActive(options: Pick<Options, "client" | "signal" | "current">): Promise<Readonly<Record<string, unknown>>> {
  const active = await options.client.session.active({ signal: options.signal })
  options.current()
  return active
}

/** Native subagent results are synthetic items tagged `source: "subagent"`. */
export function isSubagentDelivery(item: InboxItem): boolean {
  const metadata = item.type === "synthetic" ? item.payload.metadata : undefined
  return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.source === "subagent")
}

/** False when the deadline stopped workers before every item started. */
async function bounded<T>(items: T[], deadline: number, run: (item: T) => Promise<void>): Promise<boolean> {
  let next = 0, expired = false
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      if (Date.now() > deadline) { expired = true; return }
      await run(items[next++])
    }
  }))
  return !expired
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
  })
}
