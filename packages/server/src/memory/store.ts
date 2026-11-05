import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { isMap, parseDocument, stringify } from "yaml"
import { MemoryError, validateMemoryEntry, type MemoryEntry } from "./model"
import { MemoryGit } from "./git"
import { lockMemoryRepository } from "./lock"
import { decideMemorySave, memoryForAgent, reviewMemoryEntry, type MemoryReviewEntry } from "./rules"

export type MemoryNamespace = { scope: "global" } | { scope: "project"; projectId: string }
export type MemoryMutation<T> = { kind: "save"; entry: MemoryEntry; result: T }
  | { kind: "delete"; id: string; result: T } | { kind: "none"; result: T }
type Transaction = { version: 1; id: string; file: string; content: string | null }
const MAX_FILE_BYTES = 16_384

export function encodeMemoryEntry(entry: MemoryEntry): string {
  const { text, ...header } = validateMemoryEntry(entry)
  if (/[\uD800-\uDFFF]/u.test(text)) throw new MemoryError("invalid", "Invalid memory Unicode text")
  return `---\n${stringify(header)}---\n${text}`
}

export function decodeMemoryEntry(text: string): MemoryEntry {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!match || /[\uD800-\uDFFF]/u.test(match[2]!)) throw new MemoryError("malformed", "Invalid memory header")
  try {
    const header = parseDocument(match[1]!, { uniqueKeys: true })
    if (header.errors.length || header.warnings.length || !isMap(header.contents)) throw new Error("Invalid header")
    const value = header.toJS({ maxAliasCount: 0 })
    if (Object.keys(value).sort().join() !== "createdAt,id,sessionId,title,type,updatedAt") throw new Error("Invalid header fields")
    return validateMemoryEntry({ ...value, text: match[2] }, "malformed")
  } catch { throw new MemoryError("malformed", "Invalid memory entry") }
}

/** Same-directory rename replaces files on Windows too; never unlink the destination first. */
export async function atomicMemoryWrite(file: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new MemoryError("invalid", "Memory file is too large")
  const temporary = `${file}.${randomUUID()}.tmp`
  let created = false
  try {
    const handle = await open(temporary, "wx", 0o600)
    created = true
    try { await handle.writeFile(content, "utf8"); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, file)
  } finally { if (created) await rm(temporary, { force: true }).catch(() => undefined) }
}

async function regularDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new MemoryError("unreadable", "Invalid memory directory")
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    if (error instanceof MemoryError) throw error
    throw new MemoryError("unreadable", "Memory directory is unavailable")
  }
}

async function readBounded(file: string): Promise<string> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new MemoryError("unreadable", "Invalid memory file")
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > MAX_FILE_BYTES) throw new MemoryError("malformed", "Memory file is too large")
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)) }
    catch { throw new MemoryError("malformed", "Invalid memory encoding") }
  } finally { await handle.close() }
}

export class MemoryStore {
  readonly directory: string
  private readonly git: MemoryGit
  constructor(readonly configBaseDir: string, git?: MemoryGit) {
    this.directory = path.join(configBaseDir, "memory")
    this.git = git ?? new MemoryGit(this.directory)
  }

  async list(namespace: MemoryNamespace): Promise<MemoryEntry[]> {
    return memoryForAgent(await this.listStored(namespace))
  }

  async listForUI(namespace: MemoryNamespace): Promise<MemoryReviewEntry[]> {
    return (await this.listStored(namespace)).map(reviewMemoryEntry)
  }

  private async listStored(namespace: MemoryNamespace): Promise<MemoryEntry[]> {
    this.scopePath(namespace)
    // The config directory and repository stay absent for a pristine empty read.
    if (!await regularDirectory(this.configBaseDir)) return []
    if (!await regularDirectory(this.directory)) return []
    return this.locked(async () => this.readScope(namespace))
  }

  async read(namespace: MemoryNamespace, idOrTitle: string): Promise<MemoryEntry | undefined> {
    const entries = await this.list(namespace)
    return entries.find(entry => entry.id === idOrTitle) ?? entries.find(entry => entry.title === idOrTitle)
  }

  async save(namespace: MemoryNamespace, content: unknown, sessionId: string, enabled: () => boolean, id?: string): Promise<{ id: string; flagged: boolean }> {
    const saved = await this.mutate(namespace, entries => {
      if (!enabled()) throw new MemoryError("disabled", "Memory is disabled")
      try { return decideMemorySave(namespace.scope, entries, content, sessionId, id) }
      catch (error) {
        if (error instanceof MemoryError && error.code === "full")
          throw new MemoryError("full", error.message, memoryForAgent(entries).map(entry => entry.title))
        throw error
      }
    })
    return { id: saved.id, flagged: reviewMemoryEntry(saved).flagged }
  }

  /** Policy decisions (including duplicate replacement/capacity) run inside the repository lock. */
  async mutate<T>(namespace: MemoryNamespace, decide: (entries: readonly MemoryEntry[]) => MemoryMutation<T> | Promise<MemoryMutation<T>>): Promise<T> {
    const scope = this.scopePath(namespace)
    try { await mkdir(this.configBaseDir, { recursive: true, mode: 0o700 }) }
    catch { throw new MemoryError("unreadable", "Memory directory is unavailable") }
    await regularDirectory(this.configBaseDir)
    return this.locked(async () => {
      const entries = await this.readScope(namespace)
      const mutation = await decide(entries)
      if (mutation.kind === "none") return mutation.result
      let id: string, content: string | null
      if (mutation.kind === "save") {
        const entry = validateMemoryEntry(mutation.entry)
        id = entry.id
        content = encodeMemoryEntry(entry)
      } else {
        const existing = entries.find(entry => entry.id === mutation.id)
        if (!existing) throw new MemoryError("invalid", "Unknown memory entry")
        id = existing.id
        content = null
      }
      // Reject case-only filename collisions consistently across host platforms.
      if (entries.some(entry => entry.id !== id && entry.id.toLowerCase() === id.toLowerCase()))
        throw new MemoryError("conflict", "Memory entry filename conflicts")
      await this.git.initialize()
      const transaction: Transaction = { version: 1, id: randomUUID(), file: `${scope}/${id}.md`, content }
      await this.ensureScope(scope)
      await atomicMemoryWrite(this.journal, JSON.stringify(transaction))
      await this.finish(transaction, true)
      return mutation.result
    })
  }

  private get journal(): string { return path.join(this.directory, ".transaction.json") }

  private scopePath(namespace: MemoryNamespace): string {
    if (namespace.scope === "global") return "global"
    if (namespace.scope !== "project" || !/^[a-f0-9]{64}$/.test(namespace.projectId))
      throw new MemoryError("invalid", "Invalid memory namespace")
    return `projects/${namespace.projectId}`
  }

  private async ensureScope(scope: string): Promise<void> {
    let directory = this.directory
    if (!await regularDirectory(directory)) await mkdir(directory, { mode: 0o700 })
    for (const segment of scope.split("/")) {
      directory = path.join(directory, segment)
      if (!await regularDirectory(directory)) await mkdir(directory, { mode: 0o700 })
    }
  }

  private async readScope(namespace: MemoryNamespace): Promise<MemoryEntry[]> {
    if (!await regularDirectory(this.directory)) return []
    let directory = this.directory
    for (const segment of this.scopePath(namespace).split("/")) {
      directory = path.join(directory, segment)
      if (!await regularDirectory(directory)) return []
    }
    const entries: MemoryEntry[] = []
    for (const name of (await readdir(directory)).sort()) {
      if (/\.md\.[a-f0-9-]{36}\.tmp$/.test(name)) continue
      if (!name.endsWith(".md")) throw new MemoryError("malformed", "Unexpected memory file")
      const entry = decodeMemoryEntry(await readBounded(path.join(directory, name)))
      if (`${entry.id}.md` !== name) throw new MemoryError("malformed", "Memory filename and id differ")
      if (entries.some(other => other.id.toLowerCase() === entry.id.toLowerCase()))
        throw new MemoryError("malformed", "Memory filenames conflict")
      entries.push(entry)
    }
    return entries
  }

  private async finish(transaction: Transaction, discardOnReplaceFailure = false): Promise<void> {
    const destination = path.join(this.directory, transaction.file)
    try {
      if (transaction.content === null) await rm(destination, { force: true })
      else await atomicMemoryWrite(destination, transaction.content)
    } catch (error) {
      if (discardOnReplaceFailure) await rm(this.journal)
      throw error
    }
    await this.git.commit(transaction.file, transaction.id)
    await rm(this.journal)
  }

  private async recover(): Promise<void> {
    if (!await regularDirectory(this.directory)) return
    let raw: string
    try { raw = await readBounded(this.journal) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
    let transaction: Transaction
    try {
      transaction = JSON.parse(raw)
      if (transaction.version !== 1 || Object.keys(transaction).sort().join() !== "content,file,id,version"
        || typeof transaction.id !== "string" || !/^[a-f0-9-]{36}$/.test(transaction.id)
        || !/^(?:global|projects\/[a-f0-9]{64})\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.md$/.test(transaction.file)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\.md$/i.test(path.posix.basename(transaction.file))
        || !(transaction.content === null || typeof transaction.content === "string")) throw new Error("Invalid journal")
      if (transaction.content !== null && `${decodeMemoryEntry(transaction.content).id}.md` !== path.posix.basename(transaction.file))
        throw new Error("Invalid journal entry")
    } catch { throw new MemoryError("malformed", "Invalid memory transaction") }
    await this.git.initialize()
    await this.ensureScope(path.posix.dirname(transaction.file))
    await this.finish(transaction)
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockMemoryRepository(this.directory)
      await this.recover()
      return await action()
    } catch (error) {
      if (error instanceof MemoryError || (error as { code?: string }).code === "git_required") throw error
      throw new MemoryError("unreadable", "Memory storage is unavailable")
    } finally {
      try { await release?.() }
      catch { throw new MemoryError("unreadable", "Memory repository lock could not be released") }
    }
  }
}
