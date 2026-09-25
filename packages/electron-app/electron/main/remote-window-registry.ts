import type { BrowserWindow } from "electron"

interface RemoteWindowRecord {
  window: BrowserWindow
  proxySessionId?: string
}

export class RemoteWindowRegistry {
  private readonly records = new Map<string, RemoteWindowRecord>()
  private readonly operations = new Map<string, Promise<void>>()

  constructor(private readonly cleanupProxySession: (sessionId: string) => void) {}

  serialize<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(profileId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const tail = result.then(() => {}, () => {})
    this.operations.set(profileId, tail)
    void tail.then(() => {
      if (this.operations.get(profileId) === tail) this.operations.delete(profileId)
    })
    return result
  }

  reuse(profileId: string, proxySessionId?: string): BrowserWindow | undefined {
    const record = this.records.get(profileId)
    if (!record || record.window.isDestroyed()) return undefined
    if (record.proxySessionId !== proxySessionId) {
      this.records.delete(profileId)
      record.window.destroy()
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

interface RemoteNavigationAuthority {
  generation: number
  trustedOrigins: Set<string>
  insecureOrigins: Set<string>
}

const navigationAuthorities = new WeakMap<BrowserWindow, RemoteNavigationAuthority>()

export async function navigateRemoteWindow(
  window: BrowserWindow,
  target: URL,
  nextOrigins: ReadonlySet<string>,
  trustedOrigins: Map<number, Set<string>>,
  insecureOrigins: Map<number, Set<string>>,
  skipTlsVerify: boolean,
): Promise<void> {
  let authority = navigationAuthorities.get(window)
  if (!authority) {
    authority = {
      generation: 0,
      trustedOrigins: new Set(trustedOrigins.get(window.id)),
      insecureOrigins: new Set(insecureOrigins.get(window.webContents.id)),
    }
    navigationAuthorities.set(window, authority)
  }
  const generation = ++authority.generation
  const committedOrigins = new Set(nextOrigins)
  trustedOrigins.set(window.id, new Set([...authority.trustedOrigins, ...committedOrigins]))
  const provisionalInsecure = new Set(authority.insecureOrigins)
  if (skipTlsVerify) for (const origin of committedOrigins) provisionalInsecure.add(origin)
  if (provisionalInsecure.size) insecureOrigins.set(window.webContents.id, provisionalInsecure)
  else insecureOrigins.delete(window.webContents.id)

  try { await window.loadURL(target.toString()) } catch (error) {
    if (authority.generation !== generation) return
    if (authority.trustedOrigins.size) trustedOrigins.set(window.id, new Set(authority.trustedOrigins))
    else trustedOrigins.delete(window.id)
    if (authority.insecureOrigins.size) insecureOrigins.set(window.webContents.id, new Set(authority.insecureOrigins))
    else insecureOrigins.delete(window.webContents.id)
    throw error
  }

  if (authority.generation !== generation) return
  authority.trustedOrigins = committedOrigins
  authority.insecureOrigins = skipTlsVerify ? new Set(committedOrigins) : new Set()
  trustedOrigins.set(window.id, committedOrigins)
  if (authority.insecureOrigins.size) insecureOrigins.set(window.webContents.id, new Set(authority.insecureOrigins))
  else insecureOrigins.delete(window.webContents.id)
}
