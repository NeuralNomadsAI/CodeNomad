import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { access, chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, createScanner, modify, parse, parseTree, SyntaxKind, type FormattingOptions, type Node as JsonNode, type ParseError } from "jsonc-parser"

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
  prepare?(document: PluginControlDocument, updated: string, options?: PluginControlDocumentReplaceOptions): Promise<PluginControlDocumentPrepared>
}

export interface PluginControlDocumentPrepared {
  verify(): Promise<void>
  commit(): Promise<void>
  dispose(): Promise<void>
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

/** Appends one string entry (an activation rule or a source spec) at the end of `plugins`. */
export function appendPluginControlRule(document: PluginControlDocument, rule: string): string {
  const formattingOptions = inferPluginControlFormatting(document.text)
  const editPath = document.plugins.length > 0 || hasPluginsProperty(document.text)
    ? ["plugins", document.plugins.length]
    : ["plugins"]
  const value = editPath.length === 1 ? [rule] : rule
  let updated: string
  try {
    updated = editPath.length === 2
      ? appendPluginEntry(document.text, document.plugins.length, rule, formattingOptions)
      : applyEdits(document.text, modify(document.text, editPath, value, { formattingOptions }))
  } catch (error) {
    throw new PluginControlDocumentError("Unable to update OpenCode plugins without replacing the document", "invalid", { cause: error })
  }
  if (!updated.endsWith("\n")) updated += formattingOptions.eol
  return document.byteOrderMark ? `\uFEFF${updated}` : updated
}

/**
 * Deletes the string entries at `removeIndexes`, which must still read `expected`, then appends `rule` when given.
 * The result must parse to the original document with exactly those changes to `plugins`; comments, other entries,
 * line endings and the BOM stay untouched.
 */
export function replacePluginControlRules(
  document: PluginControlDocument,
  removeIndexes: readonly number[],
  expected: ReadonlySet<string>,
  rule?: string,
): string {
  const removed = [...new Set(removeIndexes)].sort((left, right) => right - left)
  if (removed.length === 0) {
    if (rule === undefined) throw new PluginControlDocumentError("OpenCode plugins edit is empty", "invalid")
    return appendPluginControlRule(document, rule)
  }
  for (const index of removed) {
    const entry = document.plugins[index]
    if (!Number.isSafeInteger(index) || typeof entry !== "string" || !expected.has(entry)) {
      throw new PluginControlDocumentError("OpenCode plugin entry changed since it was read", "conflict")
    }
  }
  const formattingOptions = inferPluginControlFormatting(document.text)
  let updated = document.text
  try {
    updated = deletePluginEntries(updated, removed)
    if (rule !== undefined) {
      updated = appendPluginEntry(updated, document.plugins.length - removed.length, rule, formattingOptions)
    }
  } catch (error) {
    throw new PluginControlDocumentError("Unable to update OpenCode plugins without replacing the document", "invalid", { cause: error })
  }
  const original = parse(document.text, [], { allowTrailingComma: true }) as Record<string, unknown>
  const plugins = (original.plugins as unknown[]).filter((_, at) => !removed.includes(at))
  const target = { ...original, plugins: rule === undefined ? plugins : [...plugins, rule] }
  const errors: ParseError[] = []
  const result = parse(updated, errors, { allowTrailingComma: true })
  if (errors.length || !isDeepStrictEqual(result, target)) {
    throw new PluginControlDocumentError("Unable to update OpenCode plugins without changing other settings", "invalid")
  }
  if (!updated.endsWith("\n")) updated += formattingOptions.eol
  return document.byteOrderMark ? `﻿${updated}` : updated
}

function appendPluginEntry(text: string, index: number, rule: string, formattingOptions: FormattingOptions): string {
  const array = parseTree(text, [], { allowTrailingComma: true })?.children
    ?.find(property => property.children?.[0]?.value === "plugins")?.children?.[1]
  const last = array?.children?.at(-1)
  if (last) {
    const end = last.offset + last.length
    const lineEnd = text.indexOf("\n", end)
    const tail = /^([ \t]*,)?[ \t]*\/\/[^\r\n]*\r?$/.exec(text.slice(end, lineEnd))
    if (lineEnd !== -1 && tail) {
      const start = text.lastIndexOf("\n", last.offset - 1) + 1
      const indent = /^[ \t]*/.exec(text.slice(start, last.offset))![0]
      // Insert the comma before the comment so it remains attached to the original entry.
      return text.slice(0, end) + (tail[1] ? "" : ",") + text.slice(end, lineEnd + 1)
        + indent + JSON.stringify(rule) + (tail[1] ? "," : "") + formattingOptions.eol + text.slice(lineEnd + 1)
    }
  }
  return applyEdits(text, modify(text, ["plugins", index], rule, { formattingOptions }))
}

/**
 * Deletes `plugins` elements and their separators, keeping surrounding comments.
 * The parse tree locates elements, including the last one in a compact array.
 */
export function deletePluginEntries(text: string, indexes: readonly number[]): string {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false })
  const array = root?.children?.find(property => property.children?.[0]?.value === "plugins")?.children?.[1]
  const children = array?.type === "array" ? array.children ?? [] : []
  const removed = new Set(indexes)
  if (!array || [...removed].some(index => !children[index])) throw new Error("OpenCode plugin entry is missing")
  const scanner = createScanner(text, true)
  const edits: Array<{ offset: number; length: number; content: string }> = []
  const commas = new Map<number, number>()
  for (let first = 0; first < children.length; first++) {
    if (!removed.has(first)) continue
    let last = first
    while (removed.has(last + 1)) last++
    // A trailing run takes its preceding separator and leaves any trailing comma with the kept entries.
    const trailing = last === children.length - 1 && first > 0
    for (let index = first - Number(trailing); index <= last - Number(trailing); index++) {
      const node = children[index]!
      scanner.setPosition(node.offset + node.length)
      if (scanner.scan() === SyntaxKind.CommaToken) commas.set(index, scanner.getTokenOffset())
    }
    first = last
  }
  for (const index of removed) {
    const { offset, length } = children[index]!
    const end = offset + length, comma = commas.get(index)
    const start = text.lastIndexOf("\n", offset - 1) + 1, lineEnd = text.indexOf("\n", end)
    // Remove a whole line only when it contains nothing else, so repeated edits don't pile up blank lines.
    const lineTail = comma !== undefined && comma < lineEnd ? text.slice(end, comma) + text.slice(comma + 1, lineEnd) : text.slice(end, lineEnd)
    if (lineEnd !== -1 && /^[ \t]*$/.test(text.slice(start, offset)) && /^[ \t\r]*$/.test(lineTail)) {
      edits.push({ offset: start, length: lineEnd + 1 - start, content: "" })
      if (comma !== undefined && comma < lineEnd) commas.delete(index)
    } else {
      edits.push({ offset, length, content: "" })
    }
  }
  for (const offset of commas.values()) edits.push({ offset, length: 1, content: "" })
  return applyEdits(text, edits)
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
  prepare: prepareHostDocument,
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
  const prepared = await prepareHostDocument(document, updated, options)
  try { await prepared.commit() } finally { await prepared.dispose() }
}

async function prepareHostDocument(
  document: PluginControlDocument,
  updated: string,
  options?: PluginControlDocumentReplaceOptions,
): Promise<PluginControlDocumentPrepared> {
  const directory = path.dirname(document.writePath)
  const temporary = `${document.writePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  let created = false
  let lock: Awaited<ReturnType<typeof acquireReplacementLock>> | undefined
  let committed = false, disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    if (lock) await lock.release()
    if (created) await rm(temporary, { force: true }).catch(() => undefined)
  }
  const verify = async () => {
    if (disposed || committed) throw new PluginControlDocumentError("OpenCode configuration preparation is closed", "conflict")
    await assertUnchanged(document)
    if (!lock || !await lock.verify())
      throw new PluginControlDocumentError("OpenCode configuration is being updated by another process", "conflict")
  }
  try {
    await mkdir(directory, { recursive: true })
    if (document.exists) {
      if (!(document.mode & 0o222)) throw new PluginControlDocumentError("OpenCode configuration is read-only", "filesystem")
      await access(document.writePath, constants.W_OK)
    }
    await access(directory, constants.W_OK)
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
    lock = await acquireReplacementLock(document.writePath)
    await verify()
    return { verify, dispose, commit: async () => {
      await verify()
      try { options?.beforeCommit?.() }
      catch (error) { throw new PluginControlDocumentError("OpenCode configuration replacement is no longer authorized", "filesystem", { cause: error }) }
      await verify()
      try { await rename(temporary, document.writePath) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (["EISDIR", "ENOTDIR", "EEXIST", "ENOTEMPTY"].includes(code ?? ""))
          throw new PluginControlDocumentError("OpenCode configuration changed during the update", "conflict", { cause: error })
        throw new PluginControlDocumentError("Unable to atomically replace OpenCode configuration", "filesystem", { cause: error })
      }
      created = false
      committed = true
    } }
  } catch (error) {
    await dispose()
    if (error instanceof PluginControlDocumentError) throw error
    throw new PluginControlDocumentError("Unable to atomically replace OpenCode configuration", "filesystem", { cause: error })
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
    const destination = await resolveHostWriteDestination(document.requestedPath)
    if (path.relative(destination, document.writePath) !== "")
      throw new PluginControlDocumentError("OpenCode configuration destination changed during the update", "conflict")
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

export function inferPluginControlFormatting(text: string): FormattingOptions {
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
