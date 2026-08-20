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

export async function navigateReusedRemoteWindow(
  window: BrowserWindow,
  target: URL,
  nextOrigins: ReadonlySet<string>,
  trustedOrigins: Map<number, Set<string>>,
  insecureOrigins: Map<number, Set<string>>,
  skipTlsVerify: boolean,
): Promise<void> {
  const committedOrigins = new Set(nextOrigins)
  const previousTrusted = trustedOrigins.get(window.id)
  const previousInsecure = insecureOrigins.get(window.webContents.id)
  trustedOrigins.set(window.id, new Set([...(previousTrusted ?? []), ...committedOrigins]))
  if (skipTlsVerify) insecureOrigins.set(window.webContents.id, new Set([...(previousInsecure ?? []), ...committedOrigins]))

  try { await window.loadURL(target.toString()) } catch (error) {
    if (previousTrusted) trustedOrigins.set(window.id, previousTrusted)
    else trustedOrigins.delete(window.id)
    if (previousInsecure) insecureOrigins.set(window.webContents.id, previousInsecure)
    else insecureOrigins.delete(window.webContents.id)
    throw error
  }

  trustedOrigins.set(window.id, committedOrigins)
  if (skipTlsVerify) insecureOrigins.set(window.webContents.id, committedOrigins)
  else insecureOrigins.delete(window.webContents.id)
}
