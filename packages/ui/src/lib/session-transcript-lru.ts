export interface TranscriptLruEntry {
  instanceId: string
  sessionId: string
  bytes: number
  lastUsed: number
}

export interface TranscriptProtectionState {
  visible?: boolean
  loading?: boolean
  status?: "idle" | "working" | "compacting"
  generationPending?: boolean
  liveMessages?: boolean
  permissionBlocked?: boolean
  questionBlocked?: boolean
}

export function isSessionTranscriptProtected(state: TranscriptProtectionState): boolean {
  return Boolean(
    state.visible
    || state.loading
    || state.status === "working"
    || state.status === "compacting"
    || state.generationPending
    || state.liveMessages
    || state.permissionBlocked
    || state.questionBlocked,
  )
}

export function selectTranscriptEvictions(
  entries: readonly TranscriptLruEntry[],
  byteBudget: number,
  isProtected: (entry: TranscriptLruEntry) => boolean,
): TranscriptLruEntry[] {
  let retainedBytes = 0
  let unboundedEntries = 0
  for (const entry of entries) {
    if (Number.isFinite(entry.bytes)) retainedBytes += entry.bytes
    else unboundedEntries += 1
  }
  if (unboundedEntries === 0 && retainedBytes <= byteBudget) return []

  const selected: TranscriptLruEntry[] = []
  for (const entry of [...entries].sort((left, right) => left.lastUsed - right.lastUsed)) {
    if (isProtected(entry)) continue
    selected.push(entry)
    if (Number.isFinite(entry.bytes)) retainedBytes -= entry.bytes
    else unboundedEntries -= 1
    if (unboundedEntries === 0 && retainedBytes <= byteBudget) break
  }
  return selected
}

interface SessionTranscriptLruOptions {
  byteBudget: number
  isProtected: (instanceId: string, sessionId: string) => boolean
  evict: (instanceId: string, sessionId: string) => void
}

export class SessionTranscriptLru {
  private entries = new Map<string, TranscriptLruEntry>()
  private pendingTouches = new Map<string, number>()
  private sequence = 0

  constructor(private options: SessionTranscriptLruOptions) {}

  account(instanceId: string, sessionId: string, bytes: number): void {
    const key = this.key(instanceId, sessionId)
    if (bytes <= 0) {
      this.entries.delete(key)
      this.pendingTouches.delete(key)
      return
    }
    const current = this.entries.get(key)
    const lastUsed = current?.lastUsed ?? this.pendingTouches.get(key) ?? ++this.sequence
    this.pendingTouches.delete(key)
    this.entries.set(key, {
      instanceId,
      sessionId,
      bytes,
      lastUsed,
    })
    this.enforce()
  }

  touch(instanceId: string, sessionId: string): boolean {
    const key = this.key(instanceId, sessionId)
    const lastUsed = ++this.sequence
    const entry = this.entries.get(key)
    if (entry) {
      entry.lastUsed = lastUsed
      return false
    }
    const needsAccounting = !this.pendingTouches.has(key)
    this.pendingTouches.set(key, lastUsed)
    return needsAccounting
  }

  forget(instanceId: string, sessionId: string): void {
    const key = this.key(instanceId, sessionId)
    this.entries.delete(key)
    this.pendingTouches.delete(key)
  }

  forgetInstance(instanceId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.instanceId === instanceId) this.entries.delete(key)
    }
    for (const key of this.pendingTouches.keys()) {
      if (key.startsWith(`${instanceId}\u0000`)) this.pendingTouches.delete(key)
    }
  }

  enforce(): void {
    const evictions = selectTranscriptEvictions(
      [...this.entries.values()],
      this.options.byteBudget,
      (entry) => this.options.isProtected(entry.instanceId, entry.sessionId),
    )
    for (const entry of evictions) {
      this.entries.delete(this.key(entry.instanceId, entry.sessionId))
      this.options.evict(entry.instanceId, entry.sessionId)
    }
  }

  private key(instanceId: string, sessionId: string): string {
    return `${instanceId}\u0000${sessionId}`
  }
}
