import type { BrowserWindow, WebContents } from "electron"

/** Invalidate the whole tree before native destruction can dispatch callbacks. */
export class BrowserGuestLifetime {
  private readonly entries = new Map<WebContents, { owner: BrowserWindow; parent?: WebContents; popup?: BrowserWindow; document: symbol }>()

  register(owner: BrowserWindow, guest: WebContents, parent?: WebContents, popup?: BrowserWindow): void {
    if (owner.isDestroyed() || owner.webContents.isDestroyed() || (parent && this.owner(parent) !== owner)) throw new Error("Expired preview owner")
    this.entries.set(guest, { owner, parent, popup, document: Symbol() })
  }

  owner(guest: WebContents | null): BrowserWindow | undefined {
    return guest && this.live(guest) ? this.entries.get(guest)?.owner : undefined
  }

  live(guest: WebContents): boolean {
    const entry = this.entries.get(guest)
    return Boolean(entry && !entry.owner.isDestroyed() && !entry.owner.webContents.isDestroyed() && !guest.isDestroyed())
  }

  descendants(opener: WebContents): void { this.dispose(new Set([opener]), false) }
  revision(guest: WebContents): symbol | undefined { return this.entries.get(guest)?.document }
  invalidateCallbacks(guest: WebContents): void {
    const entry = this.entries.get(guest)
    if (entry) entry.document = Symbol()
  }
  replaceDocument(guest: WebContents): void {
    this.invalidateCallbacks(guest)
    this.descendants(guest)
  }
  remove(guest: WebContents): void { this.dispose(new Set([guest]), true) }
  removeOwner(owner: BrowserWindow): void {
    this.dispose(new Set([...this.entries].filter(([, entry]) => entry.owner === owner).map(([guest]) => guest)), true)
  }

  private dispose(roots: Set<WebContents>, includeRoots: boolean): void {
    const selected = new Set<WebContents>(includeRoots ? roots : [])
    // ponytail: scan per tree depth; index parents if preview trees become large.
    let changed = true
    while (changed) {
      changed = false
      for (const [guest, entry] of this.entries) {
        if (entry.parent && (roots.has(entry.parent) || selected.has(entry.parent)) && !selected.has(guest)) {
          selected.add(guest); changed = true
        }
      }
    }
    const entries = [...selected].map(guest => [guest, this.entries.get(guest)] as const)
    for (const [guest] of entries) this.entries.delete(guest)
    for (const [guest, entry] of entries.reverse()) {
      if (!entry) continue
      if (entry.popup && !entry.popup.isDestroyed()) entry.popup.destroy()
      else if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false })
    }
  }
}

export const browserGuestLifetime = new BrowserGuestLifetime()
