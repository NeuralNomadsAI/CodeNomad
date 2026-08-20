import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, open, readFile, readdir, rm, unlink } from "node:fs/promises"
import { join } from "node:path"
import { hasErrorCode } from "./client-state-process"

export const CLIENT_STATE_PARTITION_PROTOCOL_VERSION = 1
export const CLIENT_STATE_PARTITION_ENVELOPE_VERSION = 2
export const MAX_CLIENT_STATE_ROOT_BYTES = 1024 * 1024
const MAX_PARTITION_BYTES = 1024 * 1024
const MAX_COMMIT_BYTES = 8 * 1024 * 1024
const MAX_PARTITION_KEYS = 4096
const PARTITION_KEY = /^[0-9a-f]{64}$/
const PARTITION_DIRECTORY = "partitions"

export interface ClientStatePartitionCommit {
  protocolVersion: 1
  snapshot: unknown
  partitions: Record<string, string>
  partitionKeys: string[]
}

export interface ValidatedClientStatePartitionCommit {
  snapshot: unknown
  partitions: Array<readonly [string, string]>
  partitionKeys: string[]
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

export function isPartitionKey(value: unknown): value is string {
  return typeof value === "string" && PARTITION_KEY.test(value)
}

export function validatePartitionKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PARTITION_KEYS) return undefined
  const keys: string[] = []
  for (const key of value) {
    if (!isPartitionKey(key) || (keys.length > 0 && keys[keys.length - 1]! >= key)) return undefined
    keys.push(key)
  }
  return keys
}

export function validateClientStatePartitionRoot(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const root = value as Record<string, unknown>
  if (root.version !== CLIENT_STATE_PARTITION_ENVELOPE_VERSION || !isPartitionKey(root.sessionPartition)) return undefined
  const partitionKeys = validatePartitionKeys(root.partitionKeys)
  return partitionKeys?.includes(root.sessionPartition) ? partitionKeys : undefined
}

export function validateClientStatePartitionCommit(value: unknown): ValidatedClientStatePartitionCommit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid client state partition commit")
  }
  const candidate = value as Partial<ClientStatePartitionCommit>
  if (candidate.protocolVersion !== CLIENT_STATE_PARTITION_PROTOCOL_VERSION) {
    throw new TypeError("Unsupported client state partition protocol")
  }
  if (!candidate.partitions || typeof candidate.partitions !== "object" || Array.isArray(candidate.partitions)) {
    throw new TypeError("Invalid client state partitions")
  }
  const partitionKeys = validatePartitionKeys(candidate.partitionKeys)
  if (!partitionKeys) throw new TypeError("Invalid client state partition keys")
  const partitions = Object.entries(candidate.partitions).sort(([left], [right]) => left.localeCompare(right))
  if (partitions.length > MAX_PARTITION_KEYS) throw new RangeError("Too many client state partitions")

  const serializedSnapshot = JSON.stringify(candidate.snapshot)
  if (serializedSnapshot === undefined) throw new TypeError("Client state root must be JSON-serializable")
  const normalizedSnapshot = JSON.parse(serializedSnapshot) as unknown
  const rootPartitionKeys = validateClientStatePartitionRoot(normalizedSnapshot)
  if (!rootPartitionKeys || rootPartitionKeys.some((key, index) => key !== partitionKeys[index])
    || rootPartitionKeys.length !== partitionKeys.length) {
    throw new TypeError("Client state root partition keys do not match the commit")
  }
  if (partitions.length !== rootPartitionKeys.length
    || partitions.some(([key], index) => key !== rootPartitionKeys[index])) {
    throw new TypeError("Client state partitions do not match the root")
  }
  const rootBytes = Buffer.byteLength(serializedSnapshot, "utf8")
  if (rootBytes > MAX_CLIENT_STATE_ROOT_BYTES) throw new RangeError("Client state root exceeds the 1 MiB limit")
  let commitBytes = rootBytes
  for (const [key, content] of partitions) {
    if (!isPartitionKey(key) || typeof content !== "string") {
      throw new TypeError("Invalid client state partition reference")
    }
    const size = Buffer.byteLength(content, "utf8")
    if (size > MAX_PARTITION_BYTES) throw new RangeError("Client state partition exceeds the 1 MiB limit")
    commitBytes += size
    if (commitBytes > MAX_COMMIT_BYTES) throw new RangeError("Client state partition commit exceeds the 8 MiB limit")
    if (digest(content) !== key) throw new TypeError("Client state partition digest mismatch")
  }
  return { snapshot: normalizedSnapshot, partitions, partitionKeys: rootPartitionKeys }
}

export async function syncDirectory(path: string): Promise<void> {
  let directory
  try {
    directory = await open(path, "r")
    await directory.sync()
  } catch (error) {
    // Windows' stdlib cannot open directories for fsync; do not mask other I/O failures.
    if (process.platform === "win32" && (hasErrorCode(error, "EISDIR") || hasErrorCode(error, "EPERM") || hasErrorCode(error, "EINVAL"))) return
    throw error
  } finally {
    await directory?.close()
  }
}

export class ClientStatePartitionStore {
  private readonly directory: string

  constructor(root: string) {
    this.directory = join(root, PARTITION_DIRECTORY)
  }

  async prepare(commit: ValidatedClientStatePartitionCommit, authorityValid: () => void): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await this.assertDirectory()
    let published = false
    for (const [key, content] of commit.partitions) published = await this.writeImmutable(key, content, authorityValid) || published
    if (published) {
      await this.assertDirectory()
      await syncDirectory(this.directory)
      authorityValid()
    }
    for (const key of commit.partitionKeys) {
      const content = await this.readVerified(key)
      authorityValid()
      if (content === null) throw new Error(`Missing client state partition ${key}`)
    }
  }

  async load(key: string, authorityValid: () => void): Promise<string | null> {
    if (!await this.assertDirectory(true)) return null
    const content = await this.readVerified(key)
    authorityValid()
    return content
  }

  async sweep(partitionKeys: readonly string[], authorityValid: () => void): Promise<void> {
    const retained = new Set(partitionKeys)
    if (!await this.assertDirectory(true)) return
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return
      throw error
    }
    authorityValid()
    for (const entry of entries) {
      if (!isPartitionKey(entry) || retained.has(entry)) continue
      const path = join(this.directory, entry)
      const stats = await lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink()) continue
      await unlink(path)
      authorityValid()
    }
  }

  private async assertDirectory(allowMissing = false): Promise<boolean> {
    try {
      const stats = await lstat(this.directory)
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Invalid client state partition directory")
      return true
    } catch (error) {
      if (allowMissing && hasErrorCode(error, "ENOENT")) return false
      throw error
    }
  }

  private async readVerified(key: string): Promise<string | null> {
    try {
      const path = join(this.directory, key)
      const stats = await lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink()) return null
      const bytes = await readFile(path)
      if (bytes.length > MAX_PARTITION_BYTES || digest(bytes) !== key) return null
      return bytes.toString("utf8")
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null
      throw error
    }
  }

  private async writeImmutable(key: string, content: string, authorityValid: () => void): Promise<boolean> {
    const path = join(this.directory, key)
    const existing = await this.readVerified(key)
    authorityValid()
    if (existing !== null) return false
    try {
      await lstat(path)
      throw new Error(`Invalid existing client state partition ${key}`)
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error
    }

    const temporary = join(this.directory, `.${key}.${process.pid}.${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.writeFile(content, "utf8")
        await file.sync()
      } finally {
        await file.close()
      }
      authorityValid()
      try {
        await link(temporary, path)
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST") || await this.readVerified(key) === null) throw error
        return false
      }
      authorityValid()
      return true
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
