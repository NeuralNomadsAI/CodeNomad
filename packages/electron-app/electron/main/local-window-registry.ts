import type { BrowserWindow, WebContents } from "electron"
import type { ClientStateNavigationController } from "./client-state-navigation"
import type { WindowStateTracker } from "./window-state"

export interface LocalWindowRecord {
  id: string
  persisted: boolean
  window: BrowserWindow
  navigation: ClientStateNavigationController
  tracker: WindowStateTracker | null
  loading: boolean
  backendUrl: string | null
  pendingFolders: PendingFolder[]
  pendingConnections?: PendingConnection[]
  /** Opened only to run a `--connect-server` launch: the host closes it once that connection settles. */
  connectOnly?: boolean
}

interface PendingFolder { path: string; attempts: number }

/** A `--connect-server` request for the renderer; `failure` is another window's message to show here. */
export interface PendingConnection { target: string; failure?: string }

const MAX_FOLDER_ATTEMPTS = 3

export class LocalWindowRegistry {
  private readonly records = new Map<string, LocalWindowRecord>()
  private readonly webContentsIds = new Map<number, string>()
  private mru: string[] = []

  constructor(private readonly setActiveWindow: (id: string) => void | Promise<void>) {}

  add(record: LocalWindowRecord): void {
    const id = record.id.toLowerCase()
    if (this.records.has(id)) throw new Error("Local window is already registered")
    if (this.records.size >= 16) throw new RangeError("Too many local windows")
    record.id = id
    this.records.set(id, record)
    this.webContentsIds.set(record.window.webContents.id, id)
    this.mru = [id, ...this.mru.filter((candidate) => candidate !== id)]
  }

  get(id: string): LocalWindowRecord | undefined {
    return this.records.get(id.toLowerCase())
  }

  all(): LocalWindowRecord[] {
    return [...this.records.values()]
  }

  resolve(sender: WebContents): LocalWindowRecord | undefined {
    const id = this.webContentsIds.get(sender.id)
    return id ? this.records.get(id) : undefined
  }

  focus(id: string): LocalWindowRecord | undefined {
    const record = this.get(id)
    if (!record || record.window.isDestroyed()) return undefined
    this.markFocused(record.id)
    if (record.window.isMinimized()) record.window.restore()
    record.window.show()
    record.window.focus()
    return record
  }

  markFocused(id: string): void {
    const record = this.get(id)
    if (!record) return
    this.mru = [record.id, ...this.mru.filter((candidate) => candidate !== record.id)]
    if (!record.persisted) return
    try {
      void Promise.resolve(this.setActiveWindow(record.id)).catch((error) => console.warn("[client-state] failed to persist active window", error))
    } catch (error) {
      console.warn("[client-state] failed to persist active window", error)
    }
  }

  mruRecord(): LocalWindowRecord | undefined {
    for (const id of this.mru) {
      const record = this.get(id)
      if (record && !record.window.isDestroyed()) return record
    }
    return undefined
  }

  focusMru(): LocalWindowRecord | undefined {
    for (const id of this.mru) {
      const focused = this.focus(id)
      if (focused) return focused
    }
    return undefined
  }

  queueFolder(id: string, folder: string): void {
    const record = this.get(id)
    if (!record) throw new Error("Unknown local window")
    record.pendingFolders.push({ path: folder, attempts: 0 })
    if (!record.window.isDestroyed() && !record.window.webContents.isDestroyed()) {
      record.window.webContents.send("window:folders-pending")
    }
  }

  nextFolder(id: string): string | null {
    const record = this.get(id)
    if (!record) throw new Error("Unknown local window")
    return record.pendingFolders[0]?.path ?? null
  }

  acknowledgeFolder(id: string, folder: string, opened: boolean): void {
    const record = this.get(id)
    if (!record) throw new Error("Unknown local window")
    const pending = record.pendingFolders.shift()
    if (pending?.path !== folder) {
      if (pending) record.pendingFolders.unshift(pending)
      throw new Error("Pending folder acknowledgement is out of order")
    }
    if (!opened && ++pending.attempts < MAX_FOLDER_ATTEMPTS) record.pendingFolders.push(pending)
  }

  queueConnection(id: string, connection: PendingConnection): void {
    const record = this.get(id)
    if (!record) throw new Error("Unknown local window")
    ;(record.pendingConnections ??= []).push(connection)
    if (!record.window.isDestroyed() && !record.window.webContents.isDestroyed()) {
      record.window.webContents.send("window:connections-pending")
    }
  }

  nextConnection(id: string): (PendingConnection & { deferFailure: boolean }) | null {
    const record = this.get(id)
    if (!record) throw new Error("Unknown local window")
    const pending = record.pendingConnections?.[0]
    return pending ? { ...pending, deferFailure: Boolean(record.connectOnly && !pending.failure) } : null
  }

  /** Removes the delivered connection; the caller decides what a failure in a connect-only window means. */
  acknowledgeConnection(id: string, target: string): { record: LocalWindowRecord; connection: PendingConnection } {
    const record = this.get(id)
    if (!record) throw new Error("Unknown local window")
    const pending = record.pendingConnections?.[0]
    if (pending?.target !== target) throw new Error("Pending connection acknowledgement is out of order")
    record.pendingConnections!.shift()
    return { record, connection: pending }
  }

  remove(id: string): LocalWindowRecord | undefined {
    const record = this.get(id)
    if (!record) return undefined
    this.records.delete(record.id)
    for (const [webContentsId, windowId] of this.webContentsIds) {
      if (windowId === record.id) this.webContentsIds.delete(webContentsId)
    }
    this.mru = this.mru.filter((candidate) => candidate !== record.id)
    return record
  }

  fanout(channel: string, payload: unknown): void {
    for (const record of this.records.values()) {
      if (!record.window.isDestroyed() && !record.window.webContents.isDestroyed()) {
        record.window.webContents.send(channel, payload)
      }
    }
  }
}
