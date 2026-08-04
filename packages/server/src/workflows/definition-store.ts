import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { WorkflowDefinitionRecord } from "../api-types"
import { parseWorkflowDefinition, WORKFLOW_DEFINITION_REVISION_LIMIT } from "./definition-schema"
import { withFilesystemLock } from "./filesystem-lock"

export { WORKFLOW_DEFINITION_REVISION_LIMIT } from "./definition-schema"

interface StoredDefinition {
  version: 1
  id: string
  currentRevision: number
  deletedAt?: string
  revisions: WorkflowDefinitionRecord[]
}

export class WorkflowDefinitionStoreError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const WORKFLOW_DEFINITION_HISTORY_BYTES_LIMIT = 4 * 1024 * 1024
export const WORKFLOW_DEFINITION_FILE_BYTES_LIMIT = WORKFLOW_DEFINITION_HISTORY_BYTES_LIMIT * 2
export const WORKFLOW_DEFINITION_RECORD_LIMIT = 1_000
export const WORKFLOW_DEFINITION_CATALOG_BYTES_LIMIT = 16 * 1024 * 1024

const revisionBytes = (record: WorkflowDefinitionRecord) => Buffer.byteLength(JSON.stringify(record), "utf8")

function assertHistoryCapacity(revisions: WorkflowDefinitionRecord[], next: WorkflowDefinitionRecord): void {
  if (revisions.length >= WORKFLOW_DEFINITION_REVISION_LIMIT) {
    throw new WorkflowDefinitionStoreError("Workflow definition revision limit reached", 409)
  }
  const bytes = revisions.reduce((total, record) => total + revisionBytes(record), revisionBytes(next))
  if (bytes > WORKFLOW_DEFINITION_HISTORY_BYTES_LIMIT) {
    throw new WorkflowDefinitionStoreError("Workflow definition history size limit reached", 409)
  }
}

export class WorkflowDefinitionStore {
  private queue = Promise.resolve()
  private listing?: Promise<WorkflowDefinitionRecord[]>

  constructor(private readonly directory: string) {}

  async create(source: string | unknown): Promise<WorkflowDefinitionRecord> {
    return this.write(async (assertOwned) => {
      const parsed = this.parse(source)
      if (await this.readFile(parsed.definition.id)) {
        throw new WorkflowDefinitionStoreError("Workflow definition already exists", 409)
      }
      await this.assertCreateCapacity()
      const now = new Date().toISOString()
      const record: WorkflowDefinitionRecord = {
        id: parsed.definition.id,
        revision: 1,
        definition: parsed.definition,
        canonical: parsed.canonical,
        createdAt: now,
        updatedAt: now,
      }
      assertHistoryCapacity([], record)
      await this.persist({ version: 1, id: record.id, currentRevision: 1, revisions: [record] }, assertOwned)
      return clone(record)
    })
  }

  async update(id: string, expectedRevision: number, source: string | unknown): Promise<WorkflowDefinitionRecord> {
    return this.write(async (assertOwned) => {
      const stored = await this.requireCurrent(id)
      if (stored.currentRevision !== expectedRevision) {
        throw new WorkflowDefinitionStoreError(`Workflow definition revision is ${stored.currentRevision}`, 409)
      }
      const parsed = this.parse(source)
      if (parsed.definition.id !== id) throw new WorkflowDefinitionStoreError("Definition ID cannot be changed", 400)
      const previous = stored.revisions.at(-1)!
      const record: WorkflowDefinitionRecord = {
        id,
        revision: expectedRevision + 1,
        definition: parsed.definition,
        canonical: parsed.canonical,
        createdAt: previous.createdAt,
        updatedAt: new Date().toISOString(),
      }
      assertHistoryCapacity(stored.revisions, record)
      stored.currentRevision = record.revision
      stored.revisions.push(record)
      await this.persist(stored, assertOwned)
      return clone(record)
    })
  }

  async delete(id: string, expectedRevision: number): Promise<boolean> {
    return this.write(async (assertOwned) => {
      const stored = await this.readFile(id)
      if (!stored || stored.deletedAt) return false
      if (stored.currentRevision !== expectedRevision) {
        throw new WorkflowDefinitionStoreError(`Workflow definition revision is ${stored.currentRevision}`, 409)
      }
      stored.deletedAt = new Date().toISOString()
      await this.persist(stored, assertOwned)
      return true
    })
  }

  async get(id: string, revision?: number): Promise<WorkflowDefinitionRecord | undefined> {
    await this.queue.catch(() => undefined)
    const stored = await this.readFile(id)
    if (!stored || stored.deletedAt) return undefined
    return this.selectRevision(stored, revision)
  }

  async inspectRevision(id: string, revision: number): Promise<WorkflowDefinitionRecord | undefined> {
    await this.queue.catch(() => undefined)
    const stored = await this.readFile(id)
    if (!stored) return undefined
    return this.selectRevision(stored, revision)
  }

  private selectRevision(stored: StoredDefinition, revision?: number): WorkflowDefinitionRecord | undefined {
    const selected = revision === undefined
      ? stored.revisions.find((record) => record.revision === stored.currentRevision)
      : stored.revisions.find((record) => record.revision === revision)
    return selected ? clone(selected) : undefined
  }

  async list(): Promise<WorkflowDefinitionRecord[]> {
    await this.queue.catch(() => undefined)
    if (this.listing) return this.listing
    const listing = this.readList()
    this.listing = listing
    try {
      return await listing
    } finally {
      if (this.listing === listing) this.listing = undefined
    }
  }

  private async readList(): Promise<WorkflowDefinitionRecord[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    entries = entries.filter((entry) => entry.endsWith(".json"))
    if (entries.length > WORKFLOW_DEFINITION_RECORD_LIMIT) {
      throw new WorkflowDefinitionStoreError("Workflow definition record limit reached", 413)
    }
    const records: WorkflowDefinitionRecord[] = []
    let catalogBytes = 0
    for (const entry of entries) {
      const stored = await this.readFile(entry.slice(0, -5))
      if (stored?.deletedAt) continue
      const record = stored?.revisions.find((candidate) => candidate.revision === stored.currentRevision)
      if (record) {
        catalogBytes += revisionBytes(record)
        if (catalogBytes > WORKFLOW_DEFINITION_CATALOG_BYTES_LIMIT) {
          throw new WorkflowDefinitionStoreError("Workflow definition catalog size limit reached", 413)
        }
        records.push(record)
      }
    }
    return records
      .sort((left, right) => left.definition.name.localeCompare(right.definition.name))
  }

  private async requireCurrent(id: string): Promise<StoredDefinition> {
    const stored = await this.readFile(id)
    if (!stored || stored.deletedAt) throw new WorkflowDefinitionStoreError("Workflow definition not found", 404)
    return stored
  }

  private async assertCreateCapacity(): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    if (entries.filter((entry) => entry.endsWith(".json")).length >= WORKFLOW_DEFINITION_RECORD_LIMIT) {
      throw new WorkflowDefinitionStoreError("Workflow definition record limit reached", 409)
    }
  }

  private async write<T>(operation: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
    const pending = this.queue.catch(() => undefined)
      .then(() => withFilesystemLock(path.join(this.directory, ".write.lock"), operation))
      .then((result) => {
        this.listing = undefined
        return result
      })
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private definitionPath(id: string) {
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(id)) throw new WorkflowDefinitionStoreError("Invalid workflow definition ID", 400)
    return path.join(this.directory, `${id}.json`)
  }

  private parse(source: string | unknown) {
    try {
      return parseWorkflowDefinition(source)
    } catch (error) {
      throw new WorkflowDefinitionStoreError(error instanceof Error ? error.message : String(error), 400)
    }
  }

  private async readFile(id: string): Promise<StoredDefinition | undefined> {
    try {
      const definitionPath = this.definitionPath(id)
      const stat = await fs.stat(definitionPath)
      if (stat.size > WORKFLOW_DEFINITION_FILE_BYTES_LIMIT) {
        throw new WorkflowDefinitionStoreError("Workflow definition stored file size limit reached", 413)
      }
      const source = await fs.readFile(definitionPath, "utf8")
      if (Buffer.byteLength(source, "utf8") > WORKFLOW_DEFINITION_FILE_BYTES_LIMIT) {
        throw new WorkflowDefinitionStoreError("Workflow definition stored file size limit reached", 413)
      }
      const stored = JSON.parse(source) as StoredDefinition
      if (stored.version !== 1 || stored.id !== id || !Number.isInteger(stored.currentRevision)
        || stored.currentRevision < 1 || stored.currentRevision > WORKFLOW_DEFINITION_REVISION_LIMIT
        || !Array.isArray(stored.revisions)) {
        throw new Error(`Invalid stored workflow definition ${id}`)
      }
      if (stored.currentRevision !== stored.revisions.length || stored.revisions.length === 0) {
        throw new Error(`Invalid stored workflow definition ${id}`)
      }
      let historyBytes = 0
      for (const record of stored.revisions) {
        historyBytes += revisionBytes(record)
        if (historyBytes > WORKFLOW_DEFINITION_HISTORY_BYTES_LIMIT) {
          throw new WorkflowDefinitionStoreError("Workflow definition history size limit reached", 413)
        }
      }
      for (const [index, record] of stored.revisions.entries()) {
        if (record.id !== id || record.definition.id !== id || record.revision !== index + 1) throw new Error(`Invalid stored workflow definition ${id}`)
        const parsed = parseWorkflowDefinition(record.definition)
        if (record.canonical !== parsed.canonical) throw new Error(`Invalid canonical workflow definition ${id}`)
      }
      return stored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  private async persist(stored: StoredDefinition, assertOwned: () => Promise<void>): Promise<void> {
    await ensureDurableDirectory(this.directory)
    const destination = this.definitionPath(stored.id)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, "wx")
      try {
        await handle.writeFile(`${JSON.stringify(stored, null, 2)}\n`, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await assertOwned()
      await fs.rename(temporary, destination)
      await syncDirectory(this.directory)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(directory, "r")
    await handle.sync()
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
  } finally {
    await handle?.close()
  }
}

async function ensureDurableDirectory(directory: string): Promise<void> {
  const created = await fs.mkdir(directory, { recursive: true })
  if (!created) return
  const firstCreated = path.resolve(created)
  let current = path.resolve(directory)
  while (true) {
    await syncDirectory(path.dirname(current))
    if (current === firstCreated) return
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}
