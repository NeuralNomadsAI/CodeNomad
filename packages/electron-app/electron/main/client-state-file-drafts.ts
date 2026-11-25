import { open } from "node:fs/promises"
import { MAX_FILE_DRAFT_BYTES, changeWorkspaceFileDrafts, normalizeWorkspaceFileDrafts } from "../../../ui/src/stores/workspace-file-drafts-codec"
import { hasErrorCode } from "./client-state-process"

// Calls run on the profile manager's write queue. Holds outlive window-record removal.
export class ClientStateFileDrafts {
  private readers = new Map<string, Set<string>>()

  constructor(private readonly path: string) {}

  release(windowId: string): void {
    this.readers.delete(windowId)
  }

  private retain(windowId: string, key: string): void {
    const keys = this.readers.get(windowId) ?? new Set<string>()
    keys.add(key)
    this.readers.set(windowId, keys)
  }

  private async read() {
    const file = await open(this.path, "r").catch(error => {
      if (!hasErrorCode(error, "ENOENT")) throw error
      return null
    })
    if (!file) return []
    try {
      const buffer = Buffer.alloc(MAX_FILE_DRAFT_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_FILE_DRAFT_BYTES) return []
      try { return normalizeWorkspaceFileDrafts(JSON.parse(buffer.toString("utf8", 0, bytesRead))) } catch { return [] }
    } finally { await file.close() }
  }

  async load(windowId: string, key: unknown, assertCurrent: () => Promise<void>) {
    const drafts = await this.read()
    await assertCurrent()
    if (key === undefined) return drafts
    const found = drafts.filter(row => row.key === key)
    if (found.length && typeof key === "string") this.retain(windowId, key)
    return found
  }

  async save(raw: unknown, windowId: string, restoreEnabled: boolean, assertCurrent: () => Promise<void>,
    write: (path: string, contents: string) => Promise<void>, isCurrentRenderer: () => boolean,
  ): Promise<boolean> {
    if (!raw || typeof raw !== "object") return false
    const { key, draft, expected } = raw as { key?: unknown; draft?: unknown; expected?: { fingerprint?: unknown; text?: unknown } | null }
    if (typeof key !== "string" || (draft !== null && (!draft || typeof draft !== "object"))
      || (expected !== null && (!expected || typeof expected !== "object"))) return false
    const value = draft === null ? null : draft as { fingerprint: string; text: string }
    if (value !== null && !restoreEnabled) return false
    const drafts = await this.read()
    await assertCurrent()
    const previous = drafts.find(row => row.key === key)
    if (!value) {
      this.readers.get(windowId)?.delete(key)
      if (Array.from(this.readers.values()).some(keys => keys.has(key))) return true
    }
    if (previous?.fingerprint !== expected?.fingerprint || previous?.text !== expected?.text) return value === null
    const next = changeWorkspaceFileDrafts(drafts, key, value)
    if (!next) return false
    await write(this.path, JSON.stringify(next))
    if (value && isCurrentRenderer()) this.retain(windowId, key)
    return true
  }
}
