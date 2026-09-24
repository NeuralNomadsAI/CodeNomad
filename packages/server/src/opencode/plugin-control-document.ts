import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse, parseTree, type FormattingOptions, type Node as JsonNode, type ParseError } from "jsonc-parser"

export const PLUGIN_CONTROL_MAX_CONFIG_BYTES = 4 * 1024 * 1024
const MAX_SYMLINK_DEPTH = 16
const REPLACEMENT_LOCK_WAIT_MS = 2_000
const REPLACEMENT_LOCK_STALE_MS = 30_000

export type PluginConfigEntry = string | {
  package: string
  options?: Record<string, unknown>
}

export class PluginControlDocumentError extends Error {
  readonly cause?: unknown

  constructor(
    message: string,
    readonly kind: "invalid" | "conflict" | "filesystem",
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = "PluginControlDocumentError"
    if (options && "cause" in options) this.cause = options.cause
  }
}

export interface PluginControlDocument {
  readonly requestedPath: string
  readonly writePath: string
  readonly exists: boolean
  readonly mode: number
  readonly text: string
  readonly byteOrderMark: boolean
  readonly plugins: readonly PluginConfigEntry[]
}

export interface PluginControlDocumentLoad {
  writePath: string
  exists: boolean
  mode: number
  contents: Buffer
}

export interface PluginControlDocumentReplaceOptions {
  beforeCommit?: () => void
}

export interface PluginControlDocumentFileSystem {
  inspectMany(requestedPaths: readonly string[]): Promise<Array<{ writePath: string; exists: boolean }>>
  load(requestedPath: string): Promise<PluginControlDocumentLoad>
  replace(document: PluginControlDocument, updated: string, options?: PluginControlDocumentReplaceOptions): Promise<void>
}

export async function readPluginControlDocument(
  requestedPath: string,
  fileSystem: PluginControlDocumentFileSystem = hostPluginControlDocumentFileSystem,
): Promise<PluginControlDocument> {
  const { writePath, exists, mode, contents } = await fileSystem.load(requestedPath)

  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents)
  } catch (error) {
    throw new PluginControlDocumentError("OpenCode configuration is not valid UTF-8", "invalid", { cause: error })
  }
  const byteOrderMark = contents.length >= 3 && contents[0] === 0xef && contents[1] === 0xbb && contents[2] === 0xbf
  const text = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length || !isRecord(value)) {
    throw new PluginControlDocumentError("OpenCode configuration is malformed", "invalid")
  }
  assertSinglePluginsProperty(parseTree(text, [], { allowTrailingComma: true, disallowComments: false }))
  const plugins = value.plugins
  if (plugins !== undefined && !Array.isArray(plugins)) {
    throw new PluginControlDocumentError("OpenCode plugins must be an array", "invalid")
  }
  const parsed = (plugins ?? []).map(parsePluginEntry)
  return { requestedPath, writePath, exists, mode, text, byteOrderMark, plugins: parsed }
}

export function appendPluginControlRule(document: PluginControlDocument, rule: string): string {
  const formattingOptions = inferFormatting(document.text)
  const editPath = document.plugins.length > 0 || hasPluginsProperty(document.text)
    ? ["plugins", document.plugins.length]
    : ["plugins"]
  const value = editPath.length === 1 ? [rule] : rule
  let updated: string
  try {
    updated = applyEdits(document.text, modify(document.text, editPath, value, { formattingOptions }))
  } catch (error) {
    throw new PluginControlDocumentError("Unable to update OpenCode plugins without replacing the document", "invalid", { cause: error })
  }
  if (!updated.endsWith("\n")) updated += formattingOptions.eol
  return document.byteOrderMark ? `\uFEFF${updated}` : updated
}

export async function replacePluginControlDocument(
  document: PluginControlDocument,
  updated: string,
  options?: PluginControlDocumentReplaceOptions,
  fileSystem: PluginControlDocumentFileSystem = hostPluginControlDocumentFileSystem,
): Promise<void> {
  return fileSystem.replace(document, updated, options)
}

export const hostPluginControlDocumentFileSystem: PluginControlDocumentFileSystem = {
  inspectMany: (requestedPaths) => Promise.all(requestedPaths.map(inspectHostDocument)),
  load: loadHostDocument,
  replace: replaceHostDocument,
}

async function inspectHostDocument(requestedPath: string): Promise<{ writePath: string; exists: boolean }> {
  const writePath = await resolveHostWriteDestination(requestedPath)
  try {
    const info = await lstat(writePath)
    if (!info.isFile()) throw new PluginControlDocumentError("OpenCode configuration target is not a regular file", "filesystem")
    return { writePath, exists: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { writePath, exists: false }
    if (error instanceof PluginControlDocumentError) throw error
    throw new PluginControlDocumentError("Unable to inspect OpenCode configuration", "filesystem", { cause: error })
  }
}

async function loadHostDocument(requestedPath: string): Promise<PluginControlDocumentLoad> {
  const writePath = await resolveHostWriteDestination(requestedPath)
  try {
    const current = await readBoundedFile(writePath)
    return { writePath, exists: true, mode: current.mode, contents: current.contents }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { writePath, exists: false, mode: 0o600, contents: Buffer.from("{}\n") }
    }
    if (error instanceof PluginControlDocumentError) throw error
    throw new PluginControlDocumentError("Unable to read OpenCode configuration", "filesystem", { cause: error })
  }
}

async function replaceHostDocument(
  document: PluginControlDocument,
  updated: string,
  options?: PluginControlDocumentReplaceOptions,
): Promise<void> {
  const directory = path.dirname(document.writePath)
  await mkdir(directory, { recursive: true })
  const temporary = `${document.writePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  let created = false
  let releaseLock: (() => Promise<void>) | undefined
  try {
    const file = await open(temporary, "wx", document.mode)
    created = true
    try {
      await file.writeFile(updated, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    // Node applies the process umask to the creation mode. Retain the source
    // document mode explicitly so a restrictive umask cannot silently tighten
    // user files and host behavior matches the WSL backend.
    await chmod(temporary, document.mode)
    const lock = await acquireReplacementLock(document.writePath)
    releaseLock = lock.release
    await assertUnchanged(document)
    try {
      options?.beforeCommit?.()
    } catch (error) {
      throw new PluginControlDocumentError("OpenCode configuration replacement is no longer authorized", "filesystem", { cause: error })
    }
    // The connection fence may run arbitrary application code in tests and a
    // non-CodeNomad editor does not honor our lock. Close that final window
    // before the atomic rename while the cross-profile lock remains held.
    await assertUnchanged(document)
    if (!await lock.verify()) {
      throw new PluginControlDocumentError("OpenCode configuration is being updated by another process", "conflict")
    }
    try {
      await rename(temporary, document.writePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EISDIR" || code === "ENOTDIR" || code === "EEXIST" || code === "ENOTEMPTY") {
        throw new PluginControlDocumentError("OpenCode configuration changed during the update", "conflict", { cause: error })
      }
      throw error
    }
    created = false
  } catch (error) {
    if (error instanceof PluginControlDocumentError) throw error
    throw new PluginControlDocumentError("Unable to atomically replace OpenCode configuration", "filesystem", { cause: error })
  } finally {
    if (releaseLock) await releaseLock().catch(() => undefined)
    if (created) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function acquireReplacementLock(writePath: string): Promise<{ release: () => Promise<void>; verify: () => Promise<boolean> }> {
  const lockPath = `${writePath}.codenomad-plugin-controls.lock`
  const ownerPath = `${lockPath}/owner`
  const nonce = randomBytes(16).toString("hex")
  const deadline = Date.now() + REPLACEMENT_LOCK_WAIT_MS
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      try {
        await writeFile(ownerPath, nonce, { mode: 0o600 })
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      let released = false
      const verify = async (): Promise<boolean> => (
        (await readFile(ownerPath, "utf8").catch(() => undefined)) === nonce
      )
      return {
        verify,
        release: async () => {
          if (released) return
          released = true
          // Only remove a lock still owned by this acquisition. A stalled owner
          // must never delete a successor's lock after its own lease expired.
          if ((await readFile(ownerPath, "utf8").catch(() => undefined)) !== nonce) return
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new PluginControlDocumentError("Unable to lock OpenCode configuration", "filesystem", { cause: error })
      }
      try {
        const info = await lstat(lockPath)
        if (Date.now() - info.mtimeMs > REPLACEMENT_LOCK_STALE_MS) {
          // Reap stale directories as well as orphaned files/symlinks so one
          // crashed writer cannot block future mutations forever.
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
          continue
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
          throw new PluginControlDocumentError("Unable to inspect OpenCode configuration lock", "filesystem", { cause: inspectionError })
        }
      }
      if (Date.now() >= deadline) {
        throw new PluginControlDocumentError("OpenCode configuration is being updated by another process", "conflict")
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

async function assertUnchanged(document: PluginControlDocument): Promise<void> {
  try {
    const current = await readBoundedFile(document.writePath)
    if (!document.exists || !current.contents.equals(encodeOriginal(document))) {
      throw new PluginControlDocumentError("OpenCode configuration changed during the update", "conflict")
    }
    if (process.platform !== "win32" && current.mode !== document.mode) {
      throw new PluginControlDocumentError("OpenCode configuration changed during the update", "conflict")
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !document.exists) return
    if (error instanceof PluginControlDocumentError) {
      if (document.exists && error.kind === "filesystem" && /not a (regular )?file/.test(error.message)) {
        throw new PluginControlDocumentError("OpenCode configuration changed during the update", "conflict", { cause: error })
      }
      throw error
    }
    throw new PluginControlDocumentError("Unable to verify OpenCode configuration before replacement", "filesystem", { cause: error })
  }
}

async function readBoundedFile(filePath: string): Promise<{ contents: Buffer; mode: number }> {
  const file = await open(filePath, "r")
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new PluginControlDocumentError("OpenCode configuration target is not a file", "filesystem")
    if (info.size > PLUGIN_CONTROL_MAX_CONFIG_BYTES) throw new PluginControlDocumentError("OpenCode configuration file is too large", "invalid")

    const buffer = Buffer.allocUnsafe(PLUGIN_CONTROL_MAX_CONFIG_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > PLUGIN_CONTROL_MAX_CONFIG_BYTES) throw new PluginControlDocumentError("OpenCode configuration file is too large", "invalid")
    return { contents: buffer.subarray(0, offset), mode: info.mode & 0o777 }
  } finally {
    await file.close()
  }
}

export function encodePluginControlOriginal(document: PluginControlDocument): Buffer {
  return encodeOriginal(document)
}

function encodeOriginal(document: PluginControlDocument): Buffer {
  return Buffer.from(`${document.byteOrderMark ? "\uFEFF" : ""}${document.text}`, "utf8")
}

async function resolveHostWriteDestination(requestedPath: string): Promise<string> {
  return resolveHostPath(path.resolve(requestedPath), 0, new Set())
}

async function resolveHostPath(current: string, depth: number, seen: Set<string>): Promise<string> {
  if (depth >= MAX_SYMLINK_DEPTH) {
    throw new PluginControlDocumentError("OpenCode configuration symlink chain is too deep", "filesystem")
  }
  try {
    return await realpath(current)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PluginControlDocumentError("Unable to resolve OpenCode configuration", "filesystem", { cause: error })
    }
  }
  let info
  try {
    info = await lstat(current)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const parent = path.dirname(current)
      if (parent === current) return current
      // Missing parents are not symlink traversals; resolve them without
      // consuming the symlink depth budget so deep new paths stay missing.
      return path.join(await resolveHostPath(parent, depth, seen), path.basename(current))
    }
    throw new PluginControlDocumentError("Unable to inspect OpenCode configuration", "filesystem", { cause: error })
  }
  if (!info.isSymbolicLink()) return current
  if (seen.has(current)) throw new PluginControlDocumentError("OpenCode configuration symlink is circular", "filesystem")
  seen.add(current)
  const target = await readlink(current)
  return resolveHostPath(path.resolve(path.dirname(current), target), depth + 1, seen)
}

function parsePluginEntry(value: unknown): PluginConfigEntry {
  if (typeof value === "string") {
    if (!value || value === "-") throw new PluginControlDocumentError("OpenCode plugin entry is invalid", "invalid")
    return value
  }
  if (!isRecord(value) || typeof value.package !== "string" || !value.package) {
    throw new PluginControlDocumentError("OpenCode plugin source is invalid", "invalid")
  }
  if (value.options !== undefined && !isRecord(value.options)) {
    throw new PluginControlDocumentError("OpenCode plugin options must be an object", "invalid")
  }
  return { package: value.package, ...(value.options === undefined ? {} : { options: value.options }) }
}

function assertSinglePluginsProperty(root: JsonNode | undefined): void {
  if (!root || root.type !== "object") throw new PluginControlDocumentError("OpenCode configuration is malformed", "invalid")
  const count = (root.children ?? []).filter((property) => property.children?.[0]?.value === "plugins").length
  if (count > 1) throw new PluginControlDocumentError("OpenCode configuration has duplicate plugins keys", "invalid")
}

function hasPluginsProperty(text: string): boolean {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false })
  return Boolean(root?.children?.some((property) => property.children?.[0]?.value === "plugins"))
}

function inferFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const indentation = text.match(/(?:^|\r?\n)([\t ]+)\S/)
  const whitespace = indentation?.[1] ?? "  "
  return {
    eol,
    insertSpaces: !whitespace.includes("\t"),
    tabSize: whitespace.includes("\t") ? 1 : Math.max(1, whitespace.length),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
