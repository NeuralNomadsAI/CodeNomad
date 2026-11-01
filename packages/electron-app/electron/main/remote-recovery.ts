import { randomUUID, timingSafeEqual } from "node:crypto"
import { REMOTE_UNAVAILABLE_HASH } from "../../../ui/src/lib/native/remote-unavailable"

interface RecoveryFrame {
  readonly origin: string
}

interface RecoveryContents {
  readonly id: number
  readonly mainFrame: RecoveryFrame
  on(event: "did-navigate", listener: (event: unknown, url: string) => void): unknown
  once(event: "destroyed", listener: () => void): unknown
}

export interface RecoveryRequest {
  sender: RecoveryContents
  senderFrame: RecoveryFrame | null
}

interface RecoveryPage {
  token: string
  retry: () => Promise<void>
  /** The origin the host's recovery document committed with; unset until it has loaded. */
  origin?: string
}

function sameToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

/**
 * The unavailable-server document the host loads in a remote window. Its native actions (Try again,
 * Open a local window) are authorised only for the exact document the host loaded: a fresh token per
 * load, carried in that document's fragment, and the main-frame origin it committed with. A document
 * the remote server controls never knows the token, cannot change its committed origin, and a
 * same-document History API change commits nothing; any cross-document navigation revokes the token.
 */
export class RemoteRecoveryPages {
  private readonly pages = new Map<number, RecoveryPage>()
  private readonly watched = new WeakSet<RecoveryContents>()

  /** Issues the token for the recovery document the host is about to load; returns its fragment. */
  issue(contents: RecoveryContents, retry: () => Promise<void>): string {
    this.watch(contents)
    const token = randomUUID()
    this.pages.set(contents.id, { token, retry })
    return `${REMOTE_UNAVAILABLE_HASH}=${token}`
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
      if (fragmentOf(url) === `#${REMOTE_UNAVAILABLE_HASH}=${page.token}`) {
        page.origin = contents.mainFrame.origin
        return
      }
      this.pages.delete(contents.id)
    })
    contents.once("destroyed", () => this.pages.delete(contents.id))
  }
}

function fragmentOf(url: string): string {
  try { return new URL(url).hash } catch { return "" }
}
