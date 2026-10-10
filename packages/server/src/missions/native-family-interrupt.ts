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
 * asynchronously, so bounded passes re-read activity and interrupt again.
 * Stop also cancels queued descendant inbox items; Pause leaves them parked
 * behind `resume: false` until an explicit Play. The root is left to the caller. */
export async function interruptNativeMissionFamily(options: Options): Promise<{ family: NativeControlFamily; descendants: MissionDescendantControl }> {
  const { client, root, signal, current } = options
  const family = await readNativeControlFamily(client, root, signal, { assertCurrent: current, deadline: options.deadline })
  const levels = new Map<number, string[]>()
  for (const [id, { depth }] of family.members) if (id !== root.id) levels.set(depth, [...(levels.get(depth) ?? []), id])
  const order = [...levels.keys()].sort((left, right) => right - left).map(depth => levels.get(depth)!)
  const interrupted: string[] = []
  const failedCancels = new Set<string>()
  let cancelled = 0, expired = false
  let active = await readActive(options)
  for (let pass = 0; pass < PASSES && order.length; pass++) {
    for (const level of order) {
      if (Date.now() > options.deadline) { expired = true; break }
      await options.checkpoint()
      // First Stop pass drains every descendant inbox, including idle ones;
      // later passes only revisit sessions observed active again.
      const targets = level.filter(id => active[id] || (options.action === "stop" && pass === 0))
      await bounded(targets, async id => {
        if (active[id]) {
          current()
          try {
            const result = await client.session.interrupt({ sessionID: id, resume: false }, { signal })
            if (result?.interrupted === true && !interrupted.includes(id)) interrupted.push(id)
          } catch { signal.throwIfAborted() }
        }
        if (options.action === "stop") {
          // Never `+= await`: concurrent workers would lose updates.
          try { const count = await cancelQueued(options, id, () => true); cancelled += count }
          catch { signal.throwIfAborted(); failedCancels.add(id) }
        }
      })
      current()
    }
    if (expired) break
    await sleep(options.settleMs ?? 250, signal)
    active = await readActive(options)
    if (!order.some(level => level.some(id => active[id]))) break
  }
  const residual = order.flat().filter(id => active[id])
  const unconfirmed = new Set([...failedCancels, ...residual]).size
  return { family, descendants: {
    observed: family.members.size - 1, interrupted: interrupted.length, cancelled, unconfirmed,
    complete: family.complete && !expired && unconfirmed === 0, sessions: interrupted.slice(0, MAX_REPORTED_DESCENDANTS),
  } }
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

async function bounded<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await run(items[next++])
  }))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
  })
}
