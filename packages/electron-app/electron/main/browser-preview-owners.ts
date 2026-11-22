export interface PreviewOwner<T> {
  window: T
  instanceId: string
  revision: number
}

/** Called synchronously in the main process, before any guest or renderer work. */
export class BrowserPreviewOwners<T> {
  private readonly owners = new Map<string, PreviewOwner<T>>()
  private recent: { sessionId: string; window: T; instanceId: string }[] = []
  private revision = 0

  get(sessionId: string) { return this.owners.get(sessionId) }

  lastUsed(sessionId: string, eligible: (window: T, instanceId: string) => boolean) {
    return this.recent.find(tab => tab.sessionId === sessionId && eligible(tab.window, tab.instanceId))
  }

  used(sessionId: string, window: T, instanceId: string) {
    this.recent = [{ sessionId, window, instanceId }, ...this.recent.filter(tab =>
      tab.sessionId !== sessionId || tab.window !== window || tab.instanceId !== instanceId)].slice(0, 512)
  }

  sessionFor(window: T, revision: number) {
    for (const [sessionId, owner] of this.owners) {
      if (owner.window === window && owner.revision === revision) return sessionId
    }
  }

  request(sessionId: string, window: T, instanceId: string, transferRevision?: number) {
    const previous = this.get(sessionId)
    if (previous && (previous.window !== window || previous.instanceId === instanceId || previous.revision !== transferRevision)) {
      return { owner: previous }
    }
    const owner = { window, instanceId, revision: ++this.revision }
    this.owners.set(sessionId, owner)
    return { owner, previous }
  }

  release(window: T, instanceId?: string) {
    this.recent = this.recent.filter(tab => tab.window !== window || (instanceId !== undefined && tab.instanceId !== instanceId))
    const released: { sessionId: string; owner: PreviewOwner<T>; revision: number }[] = []
    for (const [sessionId, owner] of this.owners) {
      if (owner.window !== window || (instanceId !== undefined && owner.instanceId !== instanceId)) continue
      this.owners.delete(sessionId)
      released.push({ sessionId, owner, revision: ++this.revision })
    }
    return released
  }
}
