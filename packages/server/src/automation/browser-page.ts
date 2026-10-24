import { randomUUID } from "node:crypto"
import type { NativeParent } from "../native-parent"
import { bindRefs, performAction, snapshotPage, type PageSession } from "./page/actions"
import type { RefAction } from "./page/parse"
import { RefTable } from "./page/refs"

export type BrowserPageAction = RefAction | { action: "snapshot"; ref?: string; query?: string }
const OPERATION_MS = 25_000
const MAX_PENDING = 32
const MAX_SESSIONS = 128

/** Runs the same page engine as the app window on an owned visible native preview.
 * Hosts retain target authority: every protocol call checks an exact operation lease
 * and document generation. No protocol method or script is accepted from a model. */
export class BrowserPage {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly tables = new Map<string, RefTable>()
  private sequence = 0
  private pending = 0
  private closed = false

  constructor(private readonly native: Pick<NativeParent, "request">) {}

  async execute(sessionID: string, action: BrowserPageAction, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("Browser automation is shutting down")
    if (this.pending >= MAX_PENDING) throw new Error("Too many pending browser operations")
    this.pending++
    const previous = this.queues.get(sessionID) ?? Promise.resolve()
    const operation = previous.then(() => this.run(sessionID, action, signal))
    const tail = operation.then(() => undefined, () => undefined)
    this.queues.set(sessionID, tail)
    try { return await operation }
    finally {
      this.pending--
      if (this.queues.get(sessionID) === tail) this.queues.delete(sessionID)
    }
  }

  close(): void { this.closed = true; this.tables.clear() }

  private async run(sessionID: string, action: BrowserPageAction, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const operationID = randomUUID(), deadline = Date.now() + OPERATION_MS
    const current = () => {
      signal?.throwIfAborted()
      if (this.closed) throw new Error("Browser automation is shutting down")
      if (Date.now() >= deadline) throw new Error("Browser operation timed out; inspect before another action")
    }
    const request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      current()
      const result = await this.native.request<T>(method, { sessionID, operationID, ...params }, Math.max(1, deadline - Date.now()))
      current()
      return result
    }
    try {
      const target = await request<{ generation: string; url: string }>("browser.page.begin", {})
      if (!target || typeof target.generation !== "string" || !target.generation || target.generation.length > 512
        || typeof target.url !== "string") throw new Error("Invalid native browser target")
      const generation = target.generation
      let url = target.url
      const page: PageSession = {
        markAutomation: false,
        channel: { send: (method, params) => request("browser.page.send", { generation, method, params: params ?? {} }) },
        checkpoint: async () => {
          const result = await request<{ url: string }>("browser.page.check", { generation })
          if (!result || typeof result.url !== "string") throw new Error("Invalid native browser target")
          url = result.url
        },
      }
      const refs = this.table(sessionID)
      if (action.action === "snapshot") {
        const rootBackendNodeId = action.ref ? refs.resolve(action.ref, generation) : undefined
        const snapshot = await snapshotPage(page, () => refs.issuer(generation), { rootBackendNodeId, query: action.query })
        return { url, snapshot: snapshot.text, collapsed: snapshot.collapsed }
      }
      const result = await performAction(page, bindRefs(action, ref => refs.resolve(ref, generation)))
      return { url, ...result }
    } finally {
      // Cleanup is exact, best effort and independent of cancellation/navigation. A lost
      // reply never replays the operation; the native lease also expires on its own.
      await this.native.request("browser.page.end", { sessionID, operationID }, 5_000).catch(() => undefined)
    }
  }

  private table(sessionID: string): RefTable {
    let table = this.tables.get(sessionID)
    if (!table) table = new RefTable("take a new snapshot", `b${++this.sequence}e`)
    this.tables.delete(sessionID)
    this.tables.set(sessionID, table)
    if (this.tables.size > MAX_SESSIONS) this.tables.delete(this.tables.keys().next().value!)
    return table
  }
}
