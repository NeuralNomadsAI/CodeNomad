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

/** Distinct evidence shared by the initial passes and the post-root rechecks of
 * one control, so a session interrupted or drained twice is counted once. */
export class FamilyControlLedger {
  readonly observed = new Set<string>()
  readonly interrupted: string[] = []
  readonly drained = new Set<string>()
  readonly failedCancels = new Set<string>()
  cancelled = 0

  interruptedSession(id: string): void { if (!this.interrupted.includes(id)) this.interrupted.push(id) }

  summary(unconfirmed: number, complete: boolean): MissionDescendantControl {
    return { observed: this.observed.size, interrupted: this.interrupted.length, cancelled: this.cancelled, unconfirmed,
      complete: complete && unconfirmed === 0, sessions: this.interrupted.slice(0, MAX_REPORTED_DESCENDANTS) }
  }
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
export async function interruptNativeMissionFamily(options: Options): Promise<{ family: NativeControlFamily; descendants: MissionDescendantControl; ledger: FamilyControlLedger }> {
  const { client, root, signal, current } = options
  // Bound in-flight native calls too: an unanswered call past the deadline is unconfirmed.
  const walk = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, options.deadline - Date.now()))])
  const native = { ...options, signal: walk }
  const ledger = new FamilyControlLedger()
  const { observed, drained, failedCancels } = ledger
  let expired = false, unknown = false, residual: string[] = []
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
      if (!await bounded(targets, options.deadline, id => controlSession(options, walk, ledger, id, Boolean(active[id]), drain.has(id)))) expired = true
      current()
      if (expired) break
    }
    if (expired) break
    try { await sleep(options.settleMs ?? 250, walk) } catch { signal.throwIfAborted(); expired = true; break }
  }
  const unconfirmed = new Set([...failedCancels, ...residual]).size
  return { family, ledger, descendants: ledger.summary(unconfirmed, family.complete && !expired && !unknown) }
}

/** Interrupts one active descendant and, on Stop, cancels its queued inputs,
 * recording distinct evidence in the shared ledger. */
async function controlSession(options: Pick<Options, "client" | "signal" | "current">, walk: AbortSignal, ledger: FamilyControlLedger,
  id: string, active: boolean, drain: boolean): Promise<void> {
  const { client, signal, current } = options
  if (active) {
    current()
    try {
      const result = await client.session.interrupt({ sessionID: id, resume: false }, { signal: walk })
      if (result?.interrupted === true) ledger.interruptedSession(id)
    } catch { signal.throwIfAborted() }
  }
  if (drain) {
    ledger.drained.add(id)
    // Never `+= await`: concurrent workers would lose updates.
    try { const count = await cancelQueued({ ...options, signal: walk }, id, () => true); ledger.cancelled += count; ledger.failedCancels.delete(id) }
    catch { signal.throwIfAborted(); ledger.failedCancels.add(id) }
  }
}

/** Post-root recheck. The root ran until its own interrupt, so a descendant still
 * (or newly) active, or newly queued, was missed or launched meanwhile: with
 * `interrupt`, stop it deepest first and, on Stop, drain its inbox under the same
 * checkpoints and ledger as the passes. Otherwise this is the verification read:
 * a family is only confirmed stopped when it is whole, inactive and has no input
 * that could re-wake it (Stop: none left; Pause: only inputs parked behind a
 * native interruption). Unknown reads fail closed. */
export async function recheckNativeMissionFamily(options: Options, ledger: FamilyControlLedger, descendants: MissionDescendantControl,
  interrupt: boolean): Promise<MissionDescendantControl> {
  const { client, root, signal, current } = options
  const walk = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, options.deadline - Date.now()))])
  const native = { ...options, signal: walk }
  try {
    const family = await readNativeControlFamily(client, root, walk, { assertCurrent: current, deadline: options.deadline })
    const active = await readActive(native)
    const order = deepestFirst(family, root.id)
    for (const id of order.flat()) ledger.observed.add(id)
    if (interrupt) {
      let expired = false
      for (const level of order) {
        const targets = level.filter(id => active[id] || options.action === "stop" && !ledger.drained.has(id))
        if (!targets.length) continue
        if (Date.now() > options.deadline) { expired = true; break }
        await options.checkpoint()
        if (!await bounded(targets, options.deadline, id => controlSession(options, walk, ledger, id, Boolean(active[id]),
          options.action === "stop"))) { expired = true; break }
        current()
      }
      const unconfirmed = new Set([...ledger.failedCancels]).size
      return ledger.summary(Math.max(descendants.unconfirmed, unconfirmed), descendants.complete && family.complete && !expired)
    }
    const awake = new Set(order.flat().filter(id => active[id]))
    const unknown = new Set(ledger.failedCancels)
    if (!await bounded(order.flat().filter(id => !awake.has(id)), options.deadline, async id => {
      try {
        const inbox = await client.session.inbox.list({ sessionID: id }, { signal: walk })
        current()
        const queued = inbox.some(item => item.type === "user" || item.type === "synthetic")
        const parked = family.members.get(id)?.session.outcome === "interrupted"
        if (inbox.length > 128 || queued && (options.action === "stop" || !parked)) awake.add(id)
      } catch { signal.throwIfAborted(); unknown.add(id) }
    })) return ledger.summary(Math.max(descendants.unconfirmed, awake.size + unknown.size, 1), false)
    // A lower bound of the distinct union: earlier passes may count these sessions.
    const unconfirmed = Math.max(descendants.unconfirmed, new Set([...awake, ...unknown]).size)
    return ledger.summary(unconfirmed, descendants.complete && family.complete)
  } catch {
    signal.throwIfAborted()
    return ledger.summary(descendants.unconfirmed, false)
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
