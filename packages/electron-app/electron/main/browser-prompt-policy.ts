import type { BrowserWindow, IpcMainEvent, WebContents } from "electron"

export function validPromptRequest(value: unknown): value is { message: string; value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const args = value as Record<string, unknown>
  return Object.keys(args).length === 2 && typeof args.message === "string" && args.message.length <= 65_536
    && typeof args.value === "string" && args.value.length <= 65_536
}

export function createBrowserPromptHandler(ownerOf: (contents: WebContents) => BrowserWindow | undefined,
  show: (owner: BrowserWindow, origin: string, message: string, value: string, source: WebContents, current: () => boolean) => Promise<string | null>,
  revisionOf: (contents: WebContents) => unknown = () => null) {
  const pending = new Set<WebContents>()
  return (event: IpcMainEvent, args: unknown) => {
    const owner = ownerOf(event.sender)
    try {
      if (!owner || owner.isDestroyed() || event.sender.isDestroyed() || pending.has(event.sender)
        || !validPromptRequest(args) || !event.senderFrame || event.senderFrame.detached
        || !event.sender.mainFrame.framesInSubtree.includes(event.senderFrame)) { event.returnValue = null; return }
      const origin = event.senderFrame.origin
      const revision = revisionOf(event.sender)
      const current = () => !owner.isDestroyed() && !event.sender.isDestroyed() && ownerOf(event.sender) === owner
        && revisionOf(event.sender) === revision && !event.senderFrame?.detached
      pending.add(event.sender)
      const reply = (value: string | null) => { try { if (!event.sender.isDestroyed()) event.returnValue = current() ? value : null } catch {} }
      void show(owner, origin, args.message, args.value, event.sender, current)
        .then(result => { pending.delete(event.sender); reply(typeof result === "string" ? result : null) },
          () => { pending.delete(event.sender); reply(null) })
    } catch { pending.delete(event.sender); event.returnValue = null }
  }
}
