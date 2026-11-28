import { randomBytes, randomUUID } from "node:crypto"
import { NativeRequestNotSent, type NativeParent } from "../native-parent"
import { bindRefs, performAction, snapshotPage, type PageSession } from "./page/actions"
import type { RefAction } from "./page/parse"
import { RefTable } from "./page/refs"
import { nativeDriver } from "./page/native-driver"

/** `budget` sets the snapshot's character budget, so larger limits expand collapsed nodes. */
export type BrowserPageAction = RefAction | { action: "snapshot"; ref?: string; query?: string; budget?: number }
  /** Reads the exact target's address only. */
  | { action: "location" }
  /** The preview host's console and network events after a sequence number, and a retained response body. */
  | { action: "diagnostics"; after: number }
  | { action: "response-body"; request: string; session?: string }
/** A host refusal because the leased document or target is no longer the one shown. */
export const pageMoved = (error: unknown) =>
  /stale; probe again|document changed|lease is no longer current/i.test(error instanceof Error ? error.message : String(error))
const OPERATION_MS = 25_000
const MAX_PENDING = 32
const MAX_SESSIONS = 128

/** Runs the same page engine as the app window on an owned visible native preview.
 * Hosts retain target authority: every protocol call checks an exact operation lease
 * and document generation. No protocol method or script is accepted from a model. */
export class BrowserPage {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly tables = new Map<string, RefTable>()
  private readonly refNamespace = BigInt(`0x${randomBytes(8).toString("hex")}`).toString().padStart(20, "0")
  private sequence = 0
  /** Fixed-prefix refs stay unique across tables, including one recreated after eviction. */
  private readonly refCounter = { next: 0 }
  private pending = 0
  private closed = false

  /** `refPrefix` replaces the per-backend ref namespace for callers whose refs follow a fixed pattern. */
  constructor(private readonly native: Pick<NativeParent, "request">, private readonly refPrefix?: string) {}

  async execute(sessionID: string, action: BrowserPageAction, signal?: AbortSignal, expectedTarget?: string,
    deadline = Number.POSITIVE_INFINITY): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("Browser automation is shutting down")
    if (this.pending >= MAX_PENDING) throw new Error("Too many pending browser operations")
    this.pending++
    const previous = this.queues.get(sessionID) ?? Promise.resolve()
    const operation = previous.then(() => this.run(sessionID, action, signal, expectedTarget, deadline))
    const tail = operation.then(() => undefined, () => undefined)
    this.queues.set(sessionID, tail)
    try { return await operation }
    finally {
      this.pending--
      if (this.queues.get(sessionID) === tail) this.queues.delete(sessionID)
    }
  }

  close(): void { this.closed = true; this.tables.clear() }

  private async run(sessionID: string, action: BrowserPageAction, signal: AbortSignal | undefined, expectedTarget: string | undefined,
    stopAt: number): Promise<Record<string, unknown>> {
    const operationID = randomUUID(), deadline = Math.min(stopAt, Date.now() + OPERATION_MS)
    let failure: Error | undefined
    let beginMayHaveReachedHost = false
    const checkDeadline = () => {
      if (Date.now() >= deadline) throw new Error("Browser operation timed out; inspect before another action")
    }
    const current = () => {
      if (failure) throw failure
      signal?.throwIfAborted()
      if (this.closed) throw new Error("Browser automation is shutting down")
      checkDeadline()
    }
    const request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      current()
      const beginning = method === "browser.page.begin"
      if (beginning) beginMayHaveReachedHost = true
      const result = await this.native.request<T>(method, { sessionID, operationID, ...params }, { deadline }).catch(error => {
        if (beginning && error instanceof NativeRequestNotSent) beginMayHaveReachedHost = false
        failure = error instanceof Error ? error : new Error(String(error))
        throw failure
      })
      current()
      return result
    }
    let result: Record<string, unknown>
    try {
      const target = await request<{ generation: string; url: string; driver: unknown; contractVersion: unknown }>(
        "browser.page.begin", expectedTarget === undefined ? {} : { target: expectedTarget })
      if (!target || typeof target.generation !== "string" || !target.generation || target.generation.length > 512
        || typeof target.url !== "string") throw new Error("Invalid native browser target")
      const generation = target.generation
      let url = target.url
      const checkpoint = async () => {
          const result = await request<{ url: string }>("browser.page.check", { generation })
          if (!result || typeof result.url !== "string") throw new Error("Invalid native browser target")
          url = result.url
      }
      const driver = nativeDriver(target, operation => request("browser.page.send", { generation, operation }), checkpoint)
      const page: PageSession = { driver, markAutomation: false, checkpoint }
      const refs = this.table(sessionID)
      if (action.action === "location") {
        // WebKit previews report no history: their tab keeps the defaults.
        const history = target.driver === "cdp"
          ? await this.native.request<Record<string, unknown>>("browser.page.send", { sessionID, operationID, generation, operation: { op: "history" } }, { deadline }).catch(() => ({}))
          : {}
        result = { ...history, url }
      }
      else if (action.action === "diagnostics" || action.action === "response-body") {
        result = await request<Record<string, unknown>>("browser.page.send", { generation, operation: action.action === "diagnostics"
          ? { op: "diagnostics", after: action.after }
          : { op: "response-body", request: action.request, ...(action.session ? { session: action.session } : {}) } })
      } else if (action.action === "snapshot") {
        const rootBackendNodeId = action.ref ? refs.resolve(action.ref, generation) : undefined
        const snapshot = await snapshotPage(page, () => refs.issuer(generation), { rootBackendNodeId, query: action.query, refLength: refs.refLength, ...(action.budget ? { budget: action.budget } : {}) })
        result = { url, snapshot: snapshot.text, collapsed: snapshot.collapsed }
      } else {
        const actionResult = await performAction(page, bindRefs(action, ref => refs.resolve(ref, generation))).catch(error => {
          // A click or key press the page received and then left (a followed link, a submitted form) was delivered.
          if ((action.action === "click" || action.action === "press") && page.inputDelivered && pageMoved(error)) return { pageChanged: true }
          throw error
        })
        result = { url, ...actionResult }
      }
    } finally {
      // Cleanup is exact, best effort and independent of cancellation/navigation. A lost
      // reply never replays the operation; the native lease also expires on its own.
      if (beginMayHaveReachedHost) await this.native.request("browser.page.end", { sessionID, operationID }, 5_000).catch(() => undefined)
    }
    checkDeadline()
    return result
  }

  private table(sessionID: string): RefTable {
    let table = this.tables.get(sessionID)
    if (!table) table = this.refPrefix ? new RefTable("take a new snapshot", this.refPrefix, undefined, this.refCounter)
      : new RefTable("take a new snapshot", `b${this.refNamespace}${++this.sequence}e`)
    this.tables.delete(sessionID)
    this.tables.set(sessionID, table)
    if (this.tables.size > MAX_SESSIONS) this.tables.delete(this.tables.keys().next().value!)
    return table
  }
}
