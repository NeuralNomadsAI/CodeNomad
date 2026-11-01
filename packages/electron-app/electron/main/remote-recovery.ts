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
  load: string
  retry: () => Promise<void>
  reload: () => void
  /** The origin the host's recovery document committed with; unset until that load commits. */
  origin?: string
}

function sameToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

/**
 * The unavailable-server document the host loads in a remote window. Its native actions (Try again,
 * Open a local window) are authorised only for the exact document the host loaded: a fresh token per
 * load, carried in that document's fragment, and the main-frame origin its own load committed with.
 * The origin is bound once, by the first commit of that load; any later main-frame commit (another
 * page, history, a reload) or a renderer crash revokes the token, and a reload shows a fresh document.
 * A document the remote server controls never knows the token, cannot change its committed origin, and
 * a same-document History API change commits nothing.
 */
export class RemoteRecoveryPages {
  private readonly pages = new Map<number, RecoveryPage>()
  private readonly watched = new WeakSet<RecoveryContents>()
  private loads = 0

  /**
   * Issues the token for the recovery document the host is about to load. `reload` shows a fresh
   * document when the authorised one is reloaded.
   */
  issue(contents: RecoveryContents, retry: () => Promise<void>, reload: () => void): RecoveryLoad {
    this.watch(contents)
    const token = randomUUID()
    const load = String(++this.loads)
    this.pages.set(contents.id, { token, load, retry, reload })
    return { query: { recovery: load }, hash: `${REMOTE_UNAVAILABLE_HASH}=${token}` }
  }

  /** The retry of the host's recovery document, when the request comes from exactly that document. */
  authorize(request: RecoveryRequest, token: unknown): (() => Promise<void>) | undefined {
    const page = this.pages.get(request.sender.id)
    const frame = request.senderFrame
    if (!page?.origin || !frame || frame !== request.sender.mainFrame) return undefined
    if (frame.origin !== page.origin || !sameToken(page.token, token)) return undefined
    return page.retry
  }

  private watch(contents: RecoveryContents): void {
    if (this.watched.has(contents)) return
    this.watched.add(contents)
    // Cross-document main-frame commits only; History API changes emit did-navigate-in-page.
    contents.on("did-navigate", (_event, url) => {
      const page = this.pages.get(contents.id)
      if (!page) return
      const ownLoad = isOwnLoad(url, page)
      if (page.origin === undefined) {
        // Commits of earlier navigations still in flight neither bind nor revoke the pending load.
        if (ownLoad) page.origin = contents.mainFrame.origin
        return
      }
      this.pages.delete(contents.id)
      if (ownLoad) page.reload()
    })
    contents.on("render-process-gone", () => this.pages.delete(contents.id))
    contents.once("destroyed", () => this.pages.delete(contents.id))
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

function isOwnLoad(url: string, page: RecoveryPage): boolean {
  try {
    const parsed = new URL(url)
    return parsed.pathname.endsWith("/loading.html") && parsed.searchParams.get("recovery") === page.load
      && parsed.hash === `#${REMOTE_UNAVAILABLE_HASH}=${page.token}`
  } catch {
    return false
  }
}
