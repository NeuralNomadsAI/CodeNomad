import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { PermissionReceipt, PermissionReceiptPage } from "../api-types"

const text = z.string().max(4096)
const id = z.string().min(1).max(512)
const snapshotSchema = z.object({
  requestId: id, sessionId: id, action: text.optional(), resources: z.array(text).max(64),
  requestMessage: text.optional(), source: z.object({ messageId: id, callId: id }).optional(),
})
const receiptSchema = snapshotSchema.extend({
  decision: z.enum(["once", "always", "reject"]), reason: text.optional(),
  origin: z.enum(["codenomad", "yolo", "native"]), resolvedAt: z.number().finite().nonnegative(),
})
const recordSchema = z.object({ request: snapshotSchema, receipt: receiptSchema.optional() })
export type PermissionSnapshot = z.infer<typeof snapshotSchema>
type RecordEntry = z.infer<typeof recordSchema>
export type ReceiptQuery = { messageId?: string; unanchored?: boolean; cursor?: string; limit?: number }
export const receiptHash = (value: string) => createHash("sha256").update(value).digest("hex")

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function permissionSnapshot(value: unknown): PermissionSnapshot | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, any>
  const bounded = (value: unknown) => typeof value === "string" ? value.slice(0, 4096) : undefined
  const parsed = snapshotSchema.safeParse({
    requestId: input.id, sessionId: input.sessionID, action: bounded(input.action),
    resources: Array.isArray(input.resources) ? input.resources.filter((v: unknown) => typeof v === "string").slice(0, 64).map(bounded) : [],
    requestMessage: bounded(input.message),
    source: input.source?.type === "tool" ? { messageId: input.source.messageID, callId: input.source.id } : undefined,
  })
  return parsed.success ? parsed.data : undefined
}

/** CodeNomad-owned, per-request files: no transcript writes or global state broadcasts. */
export class PermissionReceiptStore {
  private readonly tasks = new Map<string, Promise<unknown>>()
  private readonly deleted = new Set<string>()
  constructor(private readonly root: string) {}

  private directory(scope: string, sessionId: string) { return path.join(this.root, receiptHash(scope), receiptHash(sessionId)) }
  private serial<T>(directory: string, run: () => Promise<T>): Promise<T> {
    const task = (this.tasks.get(directory) ?? Promise.resolve()).catch(() => {}).then(run)
    this.tasks.set(directory, task)
    void task.finally(() => { if (this.tasks.get(directory) === task) this.tasks.delete(directory) }).catch(() => {})
    return task
  }
  private async read(file: string): Promise<RecordEntry | undefined> {
    try { return recordSchema.parse(JSON.parse(await readFile(file, "utf8"))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
  }
  capture(scope: string, request: PermissionSnapshot): Promise<void> {
    const directory = this.directory(scope, request.sessionId)
    return this.serial(directory, async () => {
      if (this.deleted.has(directory)) return
      const file = path.join(directory, `${receiptHash(request.requestId)}.json`)
      const previous = await this.read(file)
      if (previous) return
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeAtomic(file, JSON.stringify({ request: snapshotSchema.parse(request) }))
    })
  }
  resolve(scope: string, receipt: PermissionReceipt): Promise<PermissionReceipt | undefined> {
    const directory = this.directory(scope, receipt.sessionId)
    return this.serial(directory, async () => {
      if (this.deleted.has(directory)) return
      const file = path.join(directory, `${receiptHash(receipt.requestId)}.json`)
      const previous = await this.read(file)
      // A native event cannot erase a confirmed client origin/reason. A later
      // successful HTTP response upgrades only its exact request, never cascades.
      if (previous?.receipt && (receipt.origin === "native" || previous.receipt.origin !== "native"
        || previous.receipt.decision !== receipt.decision)) return previous.receipt
      const request = previous?.request ?? snapshotSchema.parse(receipt)
      const next = receiptSchema.parse({ ...receipt, ...request, resolvedAt: previous?.receipt?.resolvedAt ?? receipt.resolvedAt })
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeAtomic(file, JSON.stringify({ request, receipt: next }))
      return next
    })
  }
  remove(scope: string, sessionId: string): Promise<void> {
    const directory = this.directory(scope, sessionId)
    this.deleted.add(directory)
    return this.serial(directory, () => rm(directory, { recursive: true, force: true }))
  }
  async list(scope: string, sessionId: string, query: ReceiptQuery): Promise<PermissionReceiptPage> {
    const directory = this.directory(scope, sessionId)
    await this.tasks.get(directory)
    let names: string[]
    try { names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { receipts: [] }; throw error }
    const receipts: PermissionReceipt[] = []
    const remaining = names.filter(name => !query.cursor || name > query.cursor)
    let scanned = 0
    for (const name of remaining) {
      const receipt = (await this.read(path.join(directory, name)))?.receipt
      scanned++
      if (receipt && (query.unanchored ? !receipt.source : receipt.source?.messageId === query.messageId)) receipts.push(receipt)
      // Bound disk reads as well as output, including pages with no matches.
      if (receipts.length >= (query.limit ?? 100) || scanned >= 500) break
    }
    return { receipts, ...(scanned < remaining.length ? { next: remaining[scanned - 1] } : {}) }
  }
}
