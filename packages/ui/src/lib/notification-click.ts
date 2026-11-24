import { generateUUID } from "./client-identity"

type Click = { onClick: () => void | Promise<void>; signal?: AbortSignal }

/** Actions stay with the sending document, including their attachment checks. */
export function createNotificationClicks(limit = 256) {
  const pending = new Map<string, Click>()
  return {
    remember(click: Click): string {
      if (pending.size >= limit) pending.delete(pending.keys().next().value!)
      const id = generateUUID()
      pending.set(id, click)
      return id
    },
    forget(id: string): void {
      pending.delete(id)
    },
    async run(id: unknown): Promise<void> {
      if (typeof id !== "string") return
      const click = pending.get(id)
      pending.delete(id)
      if (click && !click.signal?.aborted) await click.onClick()
    },
  }
}
