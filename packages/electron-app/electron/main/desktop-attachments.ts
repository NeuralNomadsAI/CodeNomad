import { randomUUID } from "node:crypto"
import type { ClientStateManager } from "./client-state"
import type { LocalWindowRegistry } from "./local-window-registry"

/** Narrow private-parent adapter. Live tab and browser participation coverage remains unknown. */
export class DesktopAttachments {
  private captured?: { receipt: string; state: string; windows: string;
    backend?: object; owners: Map<string, string>; tabs: Map<string, { windowId: string; index: number }> }
  private backend?: object
  constructor(private readonly state: ClientStateManager, private readonly windows: LocalWindowRegistry) {}

  async handle(method: string, params?: unknown, backend?: object) {
    if (backend && backend !== this.backend) { this.backend = backend; this.captured = undefined }
    if (method === "projects.attachments.read") return this.read()
    if (method === "projects.attachments.current") return this.current((params as { receipt?: unknown } | undefined)?.receipt)
    throw new Error("attachment_inventory_unavailable")
  }

  async read() {
    const backend = this.backend
    const windowReceipt = this.windows.attachmentReceipt
    const live = this.windows.all()
    const retained = await this.state.retainedAttachments()
    const receipt = randomUUID()
    const ownerHandles = new Map<string, string>(), tabHandles = new Map<string, { windowId: string; index: number }>()
    this.captured = { receipt, state: retained.receipt, windows: windowReceipt, backend, owners: ownerHandles, tabs: tabHandles }
    const owners: Array<{ ownerId: string; live: boolean; retained: boolean }> = []
    const refs: Array<{ ownerId: string; tabId: string; source: "retained"; serverId: string; directory: string }> = []
    if (!this.current(receipt)) return { receipt, status: "unknown", retainedStatus: "unknown", owners, refs }
    const ids = new Set([...live.map(record => record.id), ...retained.windows.map(record => record.windowId)])
    for (const id of ids) {
      const ownerId = randomUUID()
      ownerHandles.set(ownerId, id)
      const record = retained.windows.find(record => record.windowId === id)
      owners.push({ ownerId, live: live.some(record => record.id === id), retained: record !== undefined })
      for (const tab of record?.tabs ?? []) {
        const tabId = randomUUID()
        tabHandles.set(tabId, { windowId: id, index: tab.index })
        refs.push({ ownerId, tabId, source: "retained", serverId: tab.serverId, directory: tab.directory })
      }
    }
    return { receipt, status: "unknown", retainedStatus: retained.status, owners, refs }
  }

  current(receipt: unknown): boolean {
    const captured = this.captured
    return typeof receipt === "string" && captured?.receipt === receipt
      && captured.backend === this.backend && captured.windows === this.windows.attachmentReceipt && this.state.attachmentReceiptCurrent(captured.state)
  }
}
