import type { BrowserWindow } from "electron"

interface RemoteWindowRecord {
  window: BrowserWindow
  proxySessionId?: string
}

export class RemoteWindowRegistry {
  private readonly records = new Map<string, RemoteWindowRecord>()

  constructor(private readonly cleanupProxySession: (sessionId: string) => void) {}

  reuse(profileId: string, proxySessionId?: string): BrowserWindow | undefined {
    const record = this.records.get(profileId)
    if (!record || record.window.isDestroyed()) return undefined
    if (record.proxySessionId !== proxySessionId) {
      this.records.delete(profileId)
      record.window.close()
      if (record.proxySessionId) this.cleanupProxySession(record.proxySessionId)
      return undefined
    }
    if (record.window.isMinimized()) record.window.restore()
    record.window.show()
    record.window.focus()
    return record.window
  }

  register(profileId: string, window: BrowserWindow, proxySessionId?: string): void {
    const record = { window, proxySessionId }
    this.records.set(profileId, record)
    window.on("closed", () => {
      if (this.records.get(profileId) !== record) return
      this.records.delete(profileId)
      if (proxySessionId) this.cleanupProxySession(proxySessionId)
    })
  }
}
