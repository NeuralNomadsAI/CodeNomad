import { randomUUID, timingSafeEqual } from "node:crypto"
import { REMOTE_UNAVAILABLE_HASH } from "../../../ui/src/lib/native/remote-unavailable"

interface RecoveryFrame {
  readonly origin: string
}

interface RecoveryContents {
  readonly id: number
  readonly mainFrame: RecoveryFrame
  on(event: "did-navigate", listener: (event: unknown, url: string) => void): unknown
  on(event: "render-process-gone", listener: () => void): unknown
  once(event: "destroyed", listener: () => void): unknown
}

export interface RecoveryRequest {
  sender: RecoveryContents
  senderFrame: RecoveryFrame | null
}

/** How the host loads its recovery document: the query makes every load a new document. */
export interface RecoveryLoad {
  query: { recovery: string }
  hash: string
}

interface RecoveryPage {
  token: string
  /** The load counter and token, as `isOwnLoad` reads them back from a committed URL. */
  key: string
  retry: () => Promise<void>
  /** The origin the host's recovery document committed with; unset until that load commits. */
  origin?: string
}

interface RecoveryWindow {
  /** The one recovery document whose actions are authorised, once its load commits. */
  active?: RecoveryPage
  /** Recovery documents this window showed whose tokens were revoked (newest last, bounded). */
  retired: string[]
  /** Shows a fresh recovery document when the user brings back a retired one. */
  reload: () => void
}

const RETIRED_PAGES = 16

function sameToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

/**
 * The unavailable-server document the host loads in a remote window. Its native actions (Try again,
 * Open a local window) are authorised only for the exact document the host loaded: a fresh token per
 * load, carried in that document's fragment, and the main-frame origin its own load committed with.
 * The origin is bound once, by the first commit of that load; any later main-frame commit (another
 * page, history, a reload) or a renderer crash revokes the token for good. Revoked documents are
 * remembered, so when the user brings one back (native Reload, also after a crash, or history) its
 * commit shows a fresh document with a fresh token; only such a user action reloads, never a crash.
 * A document the remote server controls never knows the token, cannot change its committed origin, and
 * a same-document History API change commits nothing.
 */
export class RemoteRecoveryPages {
  private readonly windows = new Map<number, RecoveryWindow>()
  private readonly watched = new WeakSet<RecoveryContents>()
  private loads = 0

  /**
   * Issues the token for the recovery document the host is about to load. `reload` shows a fresh
   * document when the user brings back one whose token was revoked.
   */
  issue(contents: RecoveryContents, retry: () => Promise<void>, reload: () => void): RecoveryLoad {
    this.watch(contents)
    const token = randomUUID()
    const load = String(++this.loads)
    const window = this.windows.get(contents.id) ?? { retired: [], reload }
    if (window.active) this.retire(window)
    window.reload = reload
    window.active = { token, key: `${load}#${token}`, retry }
    this.windows.set(contents.id, window)
    return { query: { recovery: load }, hash: `${REMOTE_UNAVAILABLE_HASH}=${token}` }
  }

  /** The retry of the host's recovery document, when the request comes from exactly that document. */
  authorize(request: RecoveryRequest, token: unknown): (() => Promise<void>) | undefined {
    const page = this.windows.get(request.sender.id)?.active
    const frame = request.senderFrame
    if (!page?.origin || !frame || frame !== request.sender.mainFrame) return undefined
    if (frame.origin !== page.origin || !sameToken(page.token, token)) return undefined
    return page.retry
  }

  private retire(window: RecoveryWindow): void {
    if (!window.active) return
    window.retired.push(window.active.key)
    if (window.retired.length > RETIRED_PAGES) window.retired.shift()
    window.active = undefined
  }

  private watch(contents: RecoveryContents): void {
    if (this.watched.has(contents)) return
    this.watched.add(contents)
    // Cross-document main-frame commits only; History API changes emit did-navigate-in-page.
    contents.on("did-navigate", (_event, url) => {
      const window = this.windows.get(contents.id)
      if (!window) return
      const key = ownLoadKey(url)
      const page = window.active
      if (page && page.origin === undefined) {
        // Commits of earlier navigations still in flight neither bind nor revoke the pending load.
        if (key === page.key) page.origin = contents.mainFrame.origin
        return
      }
      this.retire(window)
      if (key !== null && window.retired.includes(key)) window.reload()
    })
    contents.on("render-process-gone", () => {
      const window = this.windows.get(contents.id)
      if (window) this.retire(window)
    })
    contents.once("destroyed", () => this.windows.delete(contents.id))
  }
}

/** Shows the host's unavailable-server document in a remote window; Try again reruns `navigate`. */
export async function showRemoteUnavailable(
  pages: RemoteRecoveryPages,
  window: {
    webContents: RecoveryContents
    loadURL(url: string): Promise<void>
    loadFile(file: string, options: RecoveryLoad): Promise<void>
  },
  loading: { url?: string; file?: string },
  navigate: () => Promise<void>,
): Promise<void> {
  const show = () => showRemoteUnavailable(pages, window, loading, navigate)
  const load = pages.issue(window.webContents, async () => {
    try { await navigate() } catch (error) {
      console.warn("[electron] remote window retry failed", error)
      await show()
    }
  }, () => { void show().catch((error) => console.warn("[electron] failed to show the unavailable-server page", error)) })
  if (loading.url) {
    const target = new URL(loading.url)
    target.searchParams.set("recovery", load.query.recovery)
    target.hash = load.hash
    await window.loadURL(target.toString())
  } else {
    await window.loadFile(loading.file!, load)
  }
}

/** The `RecoveryPage.key` of a committed recovery-document URL; null for any other document. */
function ownLoadKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    const load = parsed.searchParams.get("recovery")
    const prefix = `#${REMOTE_UNAVAILABLE_HASH}=`
    if (!parsed.pathname.endsWith("/loading.html") || !load || !parsed.hash.startsWith(prefix)) return null
    return `${load}#${parsed.hash.slice(prefix.length)}`
  } catch {
    return null
  }
}
