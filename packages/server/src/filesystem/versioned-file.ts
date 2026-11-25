import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { canonicalAccessKey, identityAccessKey, pathAccessKey, withFileAccessKeys } from "./file-access"

export const MAX_READABLE_FILE_BYTES = 5 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024
const RENAME_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EBUSY", "EXDEV", "ENOSYS", "ENOTSUP"])
const STAGE_CREATE_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOSYS", "ENOTSUP"])
const LINK_FALLBACK_CODES = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV", "EACCES"])

export function fileVersion(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`
}

export class FileChangedError extends Error {
  readonly statusCode = 409

  constructor(message = "File changed on disk") {
    super(message)
    this.name = "FileChangedError"
  }
}

export class FileTooLargeError extends Error {
  readonly statusCode = 400
  readonly code = "file_too_large"

  constructor(message = "Selected file is too large to attach") {
    super(message)
    this.name = "FileTooLargeError"
  }
}

interface ResolvedTarget {
  targetPath: string
  parentPath: string
  existing: boolean
  stats?: fs.BigIntStats
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function isRenameFallbackError(error: unknown): boolean {
  if (error instanceof FileChangedError || error instanceof FileTooLargeError) return false
  const code = errnoCode(error)
  return typeof code === "string" && RENAME_FALLBACK_CODES.has(code)
}

function isStageCreateFallbackError(error: unknown): boolean {
  const code = errnoCode(error)
  return typeof code === "string" && STAGE_CREATE_FALLBACK_CODES.has(code)
}

function isLinkFallbackError(error: unknown): boolean {
  const code = errnoCode(error)
  return typeof code === "string" && LINK_FALLBACK_CODES.has(code)
}

async function readBounded(handle: fs.promises.FileHandle, maxBytes = MAX_READABLE_FILE_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  let position = 0
  while (true) {
    const remaining = maxBytes + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > maxBytes) throw new FileTooLargeError()
    chunks.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return Buffer.concat(chunks, total)
}

async function writeAllToHandle(handle: fs.promises.FileHandle, bytes: Buffer): Promise<void> {
  let written = 0
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written)
    written += bytesWritten
  }
  await handle.truncate(bytes.length)
  await handle.sync()
}

function rawJoin(baseDir: string, target: string, isWindows: boolean): string {
  if (path.isAbsolute(target)) return target
  const sep = baseDir.endsWith("/") || (isWindows && baseDir.endsWith("\\")) ? "" : path.sep
  return `${baseDir}${sep}${target}`
}

function isMissingPathError(error: unknown): boolean {
  const code = errnoCode(error)
  return code === "ENOENT" || code === "ENOTDIR"
}

/**
 * Resolve symlinks using OS `realpath` semantics (never collapsing `..` before intermediate symlinks),
 * falling back to hop-by-hop link walking only for missing or dangling targets.
 */
async function resolveTarget(lexicalPath: string, isWindows: boolean, conditional = false): Promise<ResolvedTarget> {
  let current = lexicalPath
  for (let hops = 0; hops < 40; hops++) {
    try {
      const real = await fs.promises.realpath(current)
      const stats = await fs.promises.lstat(real, { bigint: true })
      return { targetPath: real, parentPath: path.dirname(real), existing: true, stats }
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }

    let linkStats: fs.BigIntStats | undefined
    try {
      linkStats = await fs.promises.lstat(current, { bigint: true })
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }

    if (linkStats?.isSymbolicLink()) {
      const linkTarget = await fs.promises.readlink(current)
      if (linkTarget.endsWith("/") || (isWindows && linkTarget.endsWith("\\"))) {
        if (conditional) throw new FileChangedError()
        throw new Error("Selected path is not a file")
      }
      current = rawJoin(path.dirname(current), linkTarget, isWindows)
      continue
    }

    const leaf = path.basename(current)
    if (!leaf || leaf === "." || leaf === "..") {
      if (conditional) throw new FileChangedError()
      throw new Error("Selected path is unavailable")
    }
    try {
      const parentPath = await fs.promises.realpath(path.dirname(current))
      return { targetPath: path.join(parentPath, leaf), parentPath, existing: false }
    } catch (error) {
      if (conditional && isMissingPathError(error)) throw new FileChangedError()
      throw error
    }
  }
  throw new Error("Selected path is unavailable")
}

function physicalKeysFor(target: ResolvedTarget): string[] {
  const keys = [canonicalAccessKey(target.targetPath)]
  if (target.stats) keys.push(identityAccessKey(target.stats.dev, target.stats.ino))
  return keys
}

/**
 * Two-tier lock order: synchronously enqueue on the lexical path (`lex:*`) to preserve
 * same-path FIFO order, then acquire sorted physical keys (`canon:*`, `id:*`) to serialize
 * symlinks and hardlink aliases without deadlock.
 */
export function withResolvedFileAccess<T>(
  lexicalPath: string,
  isWindows: boolean,
  operation: (target: ResolvedTarget) => Promise<T>,
  options?: { conditional?: boolean },
): Promise<T> {
  const conditional = options?.conditional ?? false
  return withFileAccessKeys([pathAccessKey(lexicalPath)], async () => {
    let heldKeys = physicalKeysFor(await resolveTarget(lexicalPath, isWindows, conditional))
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await withFileAccessKeys(heldKeys, async () => {
        const target = await resolveTarget(lexicalPath, isWindows, conditional)
        const needed = physicalKeysFor(target)
        const heldSet = new Set(heldKeys)
        if (needed.some((key) => !heldSet.has(key))) {
          return [...new Set([...heldKeys, ...needed])]
        }
        return { value: await operation(target) }
      })
      if (!Array.isArray(result)) return result.value
      heldKeys = result
    }
    throw new FileChangedError()
  })
}

export async function readBoundedFile(
  lexicalPath: string,
  encoding: "utf-8" | "base64",
  isWindows: boolean,
): Promise<{ contents: string; version: string }> {
  return withResolvedFileAccess(lexicalPath, isWindows, async (target) => {
    if (target.existing && target.stats && !target.stats.isFile()) {
      throw new Error("Selected path is not a file")
    }
    const flags = isWindows ? "r" : fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)
    const handle = await fs.promises.open(target.targetPath, flags)
    try {
      const stats = await handle.stat({ bigint: true })
      if (!stats.isFile()) {
        throw new Error("Selected path is not a file")
      }
      if (stats.size > BigInt(MAX_READABLE_FILE_BYTES)) {
        throw new FileTooLargeError()
      }
      const buffer = await readBounded(handle, MAX_READABLE_FILE_BYTES)
      return { contents: buffer.toString(encoding), version: fileVersion(buffer) }
    } finally {
      await handle.close()
    }
  })
}

async function openOriginalWritable(
  targetPath: string,
  conditional: boolean,
  isWindows: boolean,
): Promise<{ handle: fs.promises.FileHandle; stats: fs.BigIntStats } | null> {
  const accessFlag = conditional ? fs.constants.O_RDWR : fs.constants.O_WRONLY
  const flags = isWindows
    ? accessFlag
    : accessFlag | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(targetPath, flags)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT") return null
    if (code === "ELOOP" || code === "EISDIR") {
      if (conditional) throw new FileChangedError()
      throw new Error("Selected path is not a file")
    }
    throw error
  }
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile()) {
      await handle.close()
      if (conditional) throw new FileChangedError()
      throw new Error("Selected path is not a file")
    }
    return { handle, stats }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

async function verifyHandleVersion(handle: fs.promises.FileHandle, expectedVersion: string | undefined): Promise<void> {
  if (expectedVersion === undefined) return
  const currentBytes = await readBounded(handle, MAX_READABLE_FILE_BYTES)
  if (fileVersion(currentBytes) !== expectedVersion) {
    throw new FileChangedError()
  }
}

async function createExclusiveFile(targetPath: string, bytes: Buffer): Promise<void> {
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(targetPath, "wx")
  } catch (error) {
    if (errnoCode(error) === "EEXIST") throw new FileChangedError()
    throw error
  }
  let createdStats: fs.BigIntStats | undefined
  try {
    createdStats = await handle.stat({ bigint: true })
    await writeAllToHandle(handle, bytes)
  } catch (error) {
    await handle.close().catch(() => {})
    if (createdStats) {
      const current = await fs.promises.lstat(targetPath, { bigint: true }).catch(() => undefined)
      if (current && current.dev === createdStats.dev && current.ino === createdStats.ino) {
        await fs.promises.unlink(targetPath).catch(() => {})
      }
    }
    throw error
  }
  await handle.close()
}

export async function writeVersionedFile(
  lexicalPath: string,
  contents: string,
  options: { expectedVersion?: string; isWindows: boolean },
): Promise<string> {
  const bytes = Buffer.from(contents, "utf-8")
  if (bytes.length > MAX_READABLE_FILE_BYTES) {
    throw new FileTooLargeError()
  }
  const expectedVersion = options.expectedVersion
  const conditional = expectedVersion !== undefined
  const nextVersion = fileVersion(bytes)

  return withResolvedFileAccess(lexicalPath, options.isWindows, async (target) => {
    if (target.existing && !target.stats?.isFile()) {
      if (conditional) throw new FileChangedError()
      throw new Error("Selected path is not a file")
    }

    let parentStats: fs.BigIntStats
    try {
      parentStats = await fs.promises.stat(target.parentPath, { bigint: true })
    } catch (error) {
      if (conditional && isMissingPathError(error)) throw new FileChangedError()
      throw error
    }
    const assertDestinationCurrent = async (expectedIdentity?: { dev: bigint; ino: bigint }) => {
      const currentParent = await fs.promises.stat(target.parentPath, { bigint: true }).catch(() => undefined)
      if (!currentParent || currentParent.dev !== parentStats.dev || currentParent.ino !== parentStats.ino) {
        throw new FileChangedError()
      }
      const latest = await resolveTarget(lexicalPath, options.isWindows, conditional)
      if (latest.targetPath !== target.targetPath) {
        throw new FileChangedError()
      }
      if (
        expectedIdentity
        && (!latest.existing || !latest.stats || latest.stats.dev !== expectedIdentity.dev || latest.stats.ino !== expectedIdentity.ino)
      ) {
        throw new FileChangedError()
      }
      return latest
    }

    if (!target.existing) {
      if (conditional) throw new FileChangedError()
      const tempPath = path.join(target.parentPath, `.codenomad-tmp-${process.pid}-${randomUUID()}`)
      let tempCreated = false
      try {
        let tempHandle: fs.promises.FileHandle
        try {
          tempHandle = await fs.promises.open(tempPath, "wx")
          tempCreated = true
        } catch (error) {
          if (isStageCreateFallbackError(error)) {
            const latest = await assertDestinationCurrent()
            if (latest.existing) throw new FileChangedError()
            await createExclusiveFile(target.targetPath, bytes)
            return nextVersion
          }
          throw error
        }
        try {
          await writeAllToHandle(tempHandle, bytes)
        } finally {
          await tempHandle.close()
        }
        const latest = await assertDestinationCurrent()
        if (latest.existing) throw new FileChangedError()
        try {
          await fs.promises.link(tempPath, target.targetPath)
        } catch (error) {
          if (errnoCode(error) === "EEXIST") throw new FileChangedError()
          if (isLinkFallbackError(error)) {
            await fs.promises.unlink(tempPath).catch(() => {})
            tempCreated = false
            await createExclusiveFile(target.targetPath, bytes)
            return nextVersion
          }
          throw error
        }
        await fs.promises.unlink(tempPath).catch(() => {})
        tempCreated = false
        return nextVersion
      } catch (error) {
        if (tempCreated) await fs.promises.unlink(tempPath).catch(() => {})
        throw error
      }
    }

    const lockedStats = target.stats!
    const opened = await openOriginalWritable(target.targetPath, conditional, options.isWindows)
    if (!opened) throw new FileChangedError()
    const originalStats = opened.stats
    try {
      if (originalStats.dev !== lockedStats.dev || originalStats.ino !== lockedStats.ino) {
        throw new FileChangedError()
      }
      await verifyHandleVersion(opened.handle, expectedVersion)
      if (originalStats.nlink > 1n) {
        await assertDestinationCurrent(originalStats)
        await verifyHandleVersion(opened.handle, expectedVersion)
        await writeAllToHandle(opened.handle, bytes)
        return nextVersion
      }
    } finally {
      await opened.handle.close()
    }

    const writeInPlaceVerified = async () => {
      const current = await openOriginalWritable(target.targetPath, conditional, options.isWindows)
      if (!current) throw new FileChangedError()
      try {
        if (current.stats.dev !== originalStats.dev || current.stats.ino !== originalStats.ino) {
          throw new FileChangedError()
        }
        await assertDestinationCurrent(current.stats)
        await verifyHandleVersion(current.handle, expectedVersion)
        await writeAllToHandle(current.handle, bytes)
      } finally {
        await current.handle.close()
      }
    }

    const tempPath = path.join(target.parentPath, `.codenomad-tmp-${process.pid}-${randomUUID()}`)
    // Node.js fs cannot copy POSIX ACLs, xattrs or NTFS alternate streams across rename;
    // the Rust server preserves them via native platform APIs.
    const mode = !options.isWindows ? Number(originalStats.mode) & 0o1777 : undefined
    let tempHandle: fs.promises.FileHandle
    try {
      tempHandle = await fs.promises.open(tempPath, "wx", mode)
    } catch (error) {
      if (isStageCreateFallbackError(error)) {
        await writeInPlaceVerified()
        return nextVersion
      }
      throw error
    }

    let tempCreated = true
    try {
      try {
        if (!options.isWindows) {
          const tempStats = await tempHandle.stat({ bigint: true })
          if (tempStats.uid !== originalStats.uid || tempStats.gid !== originalStats.gid) {
            try {
              await tempHandle.chown(Number(originalStats.uid), Number(originalStats.gid))
            } catch (error) {
              const code = errnoCode(error)
              if (code === "EPERM" || code === "EACCES") {
                await tempHandle.close()
                await fs.promises.unlink(tempPath).catch(() => {})
                tempCreated = false
                await writeInPlaceVerified()
                return nextVersion
              }
              throw error
            }
          }
          if (mode !== undefined) {
            await tempHandle.chmod(mode)
          }
        }
        await writeAllToHandle(tempHandle, bytes)
      } finally {
        await tempHandle.close().catch(() => {})
      }

      await assertDestinationCurrent()
      const check = await openOriginalWritable(target.targetPath, conditional, options.isWindows)
      if (!check) throw new FileChangedError()
      try {
        if (
          check.stats.dev !== originalStats.dev
          || check.stats.ino !== originalStats.ino
          || check.stats.nlink !== 1n
        ) {
          throw new FileChangedError()
        }
        await verifyHandleVersion(check.handle, expectedVersion)
      } finally {
        await check.handle.close()
      }
    } catch (error) {
      if (tempCreated) await fs.promises.unlink(tempPath).catch(() => {})
      throw error
    }

    try {
      await fs.promises.rename(tempPath, target.targetPath)
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {})
      if (isRenameFallbackError(error)) {
        await writeInPlaceVerified()
        return nextVersion
      }
      throw error
    }
    return nextVersion
  }, { conditional })
}
