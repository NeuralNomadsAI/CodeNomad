import type { NativeMutationAuthority } from "../opencode/native-mutation-authority"
import { BundlesBudget } from "./bundles-budget"
import type { BundlesChange } from "./bundles-contract"

export const BUNDLES_PLAN_MS = 300_000, BUNDLES_CONFIRMATION_MS = 120_000, BUNDLES_CONFIRM_GUARD_MS = 600
export const BUNDLES_CANCEL_WINDOW_MS = 60_000, BUNDLES_CANCEL_LIMIT = 3, BUNDLES_CUTOFF_MS = 300_000
export type BundlesAck = { outcome: "confirming"; requestID: string } | { outcome: "busy" | "invalid" }
type Terminal = "confirmed" | "cancelled" | "expired" | "failed"
export interface BundlesClock {
  now(): number
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}
const clock: BundlesClock = { now: () => Date.now(), setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }
const opaque = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")

/** Backend-only values supplied by the operation-specific trusted builder, never frame input. */
export interface BundlesTarget {
  instance: string; session: string; location: string; connection: string
  integration: string; scope: "global" | "project"; range: string; documentDigest: string
}
export interface BundlesConfirmation {
  requestID: string; planID: string
  action: "install" | "update" | "remove" | "enable" | "disable" | "installHost" | "attach"
  integration: string; scope: "global" | "project"; version: string; conversation: string; document?: string
}
export interface BundlesPrepared {
  target: BundlesTarget
  display: Omit<BundlesConfirmation, "requestID" | "planID">
  /** Fresh server reads of all captured bindings, including exact document/catalogue. */
  readTarget(signal: AbortSignal): Promise<BundlesTarget>
  /** Internal admission seam. Call submitted exactly at native dispatch, using this same authority. */
  dispatch(authority: NativeMutationAuthority, submitted: () => void): Promise<void>
}
export interface BundlesMount {
  readonly extension: string; readonly digest: string; readonly mountID: string
  readonly authority: NativeMutationAuthority & { readonly signal: AbortSignal }; readonly signal: AbortSignal
  changed(event: BundlesChange): void
  show(view: BundlesConfirmation | null): void
}
interface Pending {
  owner: BundlesMount; requestID: string; planID: string; deadline: number; controller: AbortController
  phase: "reserved" | "preparing" | "confirming" | "dispatching" | "terminal"
  timer?: unknown; shownAt?: number; prepared?: BundlesPrepared; notified?: boolean; removeAbort(): void
}
const sameTarget = (a: BundlesTarget, b: BundlesTarget) =>
  (Object.keys(a) as Array<keyof BundlesTarget>).every(key => a[key] === b[key]) && Object.keys(a).length === Object.keys(b).length

/** One backend/profile arbiter, shared by every extension/window. Memory only; no public mutator routes. */
export class BundlesLifecycle {
  private active?: Pending
  private strikes = new Map<string, { times: number[]; until: number }>()
  readonly budget: BundlesBudget
  constructor(private readonly time: BundlesClock = clock, budget?: BundlesBudget) {
    this.budget = budget ?? new BundlesBudget(() => time.now())
  }

  /** Mount identity is minted here. The host supplies genuine revocable authority and a disposal signal. */
  mount(input: Omit<BundlesMount, "mountID">): BundlesMount {
    return Object.freeze({ ...input, signal: AbortSignal.any([input.signal, input.authority.signal]), mountID: opaque() })
  }

  /** Only an explicit trusted user remount calls this; mounting itself preserves all budgets and strikes. */
  resetCutoffForUserRemount(extension: string): void { this.strikes.delete(extension) }

  /** Synchronous ACK reservation. Call afterAck only after posting the ACK to the captured port. */
  request(owner: BundlesMount, prepare: (signal: AbortSignal) => Promise<BundlesPrepared>): { ack: BundlesAck; afterAck(): void } {
    const refused = (outcome: "busy" | "invalid") => ({ ack: { outcome } as BundlesAck, afterAck() {} })
    try { owner.signal.throwIfAborted(); owner.authority.assertCurrent() } catch { return refused("invalid") }
    if (!this.budget.take(owner.extension, "manage") || this.active || (this.strikes.get(owner.extension)?.until ?? 0) > this.time.now()) return refused("busy")
    const pending: Pending = { owner, requestID: opaque(), planID: opaque(), deadline: this.time.now() + BUNDLES_PLAN_MS,
      phase: "reserved", controller: new AbortController(), removeAbort() {} }
    const revoke = () => this.finish(pending, "failed")
    owner.signal.addEventListener("abort", revoke, { once: true })
    pending.removeAbort = () => owner.signal.removeEventListener("abort", revoke)
    this.active = pending
    pending.timer = this.time.setTimeout(() => this.finish(pending, "expired"), BUNDLES_PLAN_MS)
    return { ack: { outcome: "confirming", requestID: pending.requestID }, afterAck: () => {
      if (pending.phase !== "reserved") return
      pending.phase = "preparing"
      void this.prepare(pending, prepare)
    } }
  }

  private assert(pending: Pending): void {
    if (this.active !== pending || pending.phase === "terminal" || this.expired(pending)) throw new Error("Stale bundles plan")
    pending.controller.signal.throwIfAborted(); pending.owner.signal.throwIfAborted(); pending.owner.authority.assertCurrent()
  }

  private expired(pending: Pending): boolean {
    return this.time.now() >= pending.deadline || (pending.phase === "confirming" && pending.shownAt !== undefined
      && this.time.now() >= pending.shownAt + BUNDLES_CONFIRMATION_MS)
  }

  private async prepare(pending: Pending, prepare: (signal: AbortSignal) => Promise<BundlesPrepared>): Promise<void> {
    try {
      this.assert(pending)
      await pending.owner.authority.revalidate(); this.assert(pending)
      const result = await prepare(pending.controller.signal); this.assert(pending)
      // Copy scalars: later mutation of a builder's objects cannot widen the captured consent.
      pending.prepared = { ...result, target: Object.freeze({ ...result.target }), display: Object.freeze({ ...result.display }) }
      pending.phase = "confirming"
      // The trusted view calls displayed() on mount; preparation/rendering time never unlocks Confirm.
      pending.owner.show(Object.freeze({ ...pending.prepared.display, requestID: pending.requestID, planID: pending.planID }))
    } catch { this.finish(pending, this.expired(pending) ? "expired" : "failed") }
  }

  displayed(owner: BundlesMount, planID: string): void {
    const pending = this.active
    if (!pending || pending.owner !== owner || pending.planID !== planID || pending.phase !== "confirming" || pending.shownAt !== undefined) return
    try { this.assert(pending) } catch { this.finish(pending, this.expired(pending) ? "expired" : "failed"); return }
    pending.shownAt = this.time.now()
    this.time.clearTimeout(pending.timer)
    pending.timer = this.time.setTimeout(() => this.finish(pending, "expired"), Math.min(BUNDLES_CONFIRMATION_MS, pending.deadline - this.time.now()))
  }

  cancel(owner: BundlesMount, planID: string): void {
    const pending = this.active
    if (pending?.owner === owner && pending.planID === planID && pending.phase === "confirming") this.finish(pending, this.expired(pending) ? "expired" : "cancelled")
  }

  confirm(owner: BundlesMount, planID: string): void {
    const pending = this.active
    if (!pending || pending.owner !== owner || pending.planID !== planID || pending.phase !== "confirming"
      || pending.shownAt === undefined || this.time.now() - pending.shownAt < BUNDLES_CONFIRM_GUARD_MS) return
    try { this.assert(pending) } catch { this.finish(pending, this.expired(pending) ? "expired" : "failed"); return }
    // Consume synchronously before any await: click/Enter races and replays are inert.
    pending.phase = "dispatching"
    this.time.clearTimeout(pending.timer)
    pending.timer = this.time.setTimeout(() => this.finish(pending, "expired"), Math.max(0, pending.deadline - this.time.now()))
    pending.owner.show(null)
    void this.dispatch(pending)
  }

  private async dispatch(pending: Pending): Promise<void> {
    const prepared = pending.prepared!
    const authority: NativeMutationAuthority = {
      assertCurrent: () => this.assert(pending),
      revalidate: async () => {
        this.assert(pending); await pending.owner.authority.revalidate(); this.assert(pending)
        const target = await prepared.readTarget(pending.controller.signal); this.assert(pending)
        if (!sameTarget(prepared.target, target)) throw new Error("Stale bundles target")
      },
    }
    try {
      await authority.revalidate(); authority.assertCurrent()
      let submitted = false
      await prepared.dispatch(authority, () => {
        if (submitted) throw new Error("Bundles request already submitted")
        authority.assertCurrent(); submitted = true
        // This event means admitted transmission, independent of its later native outcome.
        pending.notified = true
        pending.owner.changed({ kind: "request", requestID: pending.requestID, outcome: "confirmed" })
      })
      this.finish(pending, submitted ? "confirmed" : "failed")
    } catch { this.finish(pending, this.expired(pending) ? "expired" : "failed") }
  }

  private finish(pending: Pending, outcome: Terminal): void {
    if (pending.phase === "terminal") return
    pending.phase = "terminal"
    this.time.clearTimeout(pending.timer); pending.removeAbort()
    pending.controller.abort()
    if (this.active === pending) this.active = undefined
    pending.owner.show(null)
    if (outcome === "cancelled" || outcome === "expired") {
      const at = this.time.now(), previous = this.strikes.get(pending.owner.extension)
      const times = (previous?.times ?? []).filter(time => time > at - BUNDLES_CANCEL_WINDOW_MS)
      times.push(at)
      this.strikes.set(pending.owner.extension, { times, until: times.length >= BUNDLES_CANCEL_LIMIT ? at + BUNDLES_CUTOFF_MS : previous?.until ?? 0 })
    }
    // Uncoalesced and extension/mount-local. A disposed port drops delivery; it never forwards to a new mount.
    if (!pending.notified) {
      pending.notified = true
      pending.owner.changed({ kind: "request", requestID: pending.requestID, outcome })
    }
  }

  dispose(): void { if (this.active) this.finish(this.active, "failed") }
}
