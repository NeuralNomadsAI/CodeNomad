import { randomUUID } from "node:crypto"
import type { BrowserWindow, Event, IpcMain, IpcMainInvokeEvent, NotificationCloseEventParams, NotificationConstructorOptions } from "electron"

interface Notice {
  once(event: "click" | "failed", listener: () => void): void
  once(event: "close", listener: (event: Event<NotificationCloseEventParams>) => void): void
  show(): void
}

export function setupNotificationIPC(
  ipc: Pick<IpcMain, "handle">,
  authorize: (event: IpcMainInvokeEvent) => BrowserWindow,
  create: (options: NotificationConstructorOptions) => Notice | undefined,
  windows = process.platform === "win32",
): void {
  const documents = new WeakMap<IpcMainInvokeEvent["sender"], { generation: number }>()
  // The native delegate holds a weak reference to its JS wrapper.
  const live = new Set<Notice>()
  ipc.handle("notifications:show", (event, payload: unknown) => {
    const window = authorize(event)
    const { title, body, actionId } = parseNotification(payload)
    try {
      const notice = create(windows ? windowsToast(title, body) : { title, body })
      if (!notice) return { ok: false, reason: "unsupported" }
      const contents = event.sender
      let document = documents.get(contents)
      if (!document) {
        const lifetime = { generation: 0 }
        contents.on("did-start-navigation", details => {
          if (details.isMainFrame && !details.isSameDocument) lifetime.generation++
        })
        contents.on("render-process-gone", () => lifetime.generation++)
        documents.set(contents, lifetime)
        document = lifetime
      }
      const generation = document.generation
      const frame = event.senderFrame
      notice.once("click", () => {
        if (!live.delete(notice)) return
        try {
          if (!frame || document.generation !== generation || event.senderFrame !== frame || authorize(event) !== window) return
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
          if (actionId) frame.send("notifications:click", actionId)
        } catch {
          // The sending window or its authorized renderer is gone.
        }
      })
      notice.once("close", event => {
        // A Windows toast that timed out can still be clicked in Notification Center.
        if (event?.reason !== "timedOut") live.delete(notice)
      })
      notice.once("failed", () => { live.delete(notice) })
      if (live.size >= 256) live.delete(live.values().next().value!)
      live.add(notice)
      try { notice.show() } catch (error) { live.delete(notice); throw error }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })
}

function windowsToast(title: string, body: string): NotificationConstructorOptions {
  // Electron's COM activator matches the launch tag to the live Notification's ID.
  const id = randomUUID()
  const text = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return { id, title, body, toastXml: `<toast launch="type=click&amp;tag=${id}"><visual><binding template="ToastGeneric"><text>${text(title)}</text><text>${text(body)}</text></binding></visual></toast>` }
}

function parseNotification(payload: unknown): { title: string; body: string; actionId?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid notification")
  const { title, body, actionId } = payload as Record<string, unknown>
  if (typeof title !== "string" || typeof body !== "string"
    || (actionId !== undefined && (typeof actionId !== "string" || actionId.length !== 36
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(actionId)))) {
    throw new Error("Invalid notification")
  }
  return { title, body, actionId }
}
