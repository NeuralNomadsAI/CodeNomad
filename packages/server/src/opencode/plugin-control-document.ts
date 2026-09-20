import { randomBytes } from "node:crypto"
import { lstat, mkdir, open, readlink, rename, rm } from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse, parseTree, type FormattingOptions, type Node as JsonNode, type ParseError } from "jsonc-parser"

const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const MAX_SYMLINK_DEPTH = 16

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

export async function readPluginControlDocument(requestedPath: string): Promise<PluginControlDocument> {
  const writePath = await resolveWriteDestination(requestedPath)
  let contents: Buffer
  let exists = true
  let mode = 0o600
  try {
    const current = await readBoundedFile(writePath)
    contents = current.contents
    mode = current.mode
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof PluginControlDocumentError) throw error
      throw new PluginControlDocumentError("Unable to read OpenCode configuration", "filesystem", { cause: error })
    }
    exists = false
    contents = Buffer.from("{}\n")
  }

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
): Promise<void> {
  const directory = path.dirname(document.writePath)
  await mkdir(directory, { recursive: true })
  const temporary = `${document.writePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  let created = false
  try {
    const file = await open(temporary, "wx", document.mode)
    created = true
    try {
      await file.writeFile(updated, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await assertUnchanged(document)
    await rename(temporary, document.writePath)
    created = false
  } catch (error) {
    if (error instanceof PluginControlDocumentError) throw error
    throw new PluginControlDocumentError("Unable to atomically replace OpenCode configuration", "filesystem", { cause: error })
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function assertUnchanged(document: PluginControlDocument): Promise<void> {
  try {
    const current = await readBoundedFile(document.writePath)
    if (!document.exists || !current.contents.equals(encodeOriginal(document))) {
      throw new PluginControlDocumentError("OpenCode configuration changed during the update", "conflict")
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !document.exists) return
    if (error instanceof PluginControlDocumentError) throw error
    throw new PluginControlDocumentError("Unable to verify OpenCode configuration before replacement", "filesystem", { cause: error })
  }
}

async function readBoundedFile(filePath: string): Promise<{ contents: Buffer; mode: number }> {
  const file = await open(filePath, "r")
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new PluginControlDocumentError("OpenCode configuration target is not a file", "filesystem")
    if (info.size > MAX_CONFIG_BYTES) throw new PluginControlDocumentError("OpenCode configuration file is too large", "invalid")

    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_CONFIG_BYTES) throw new PluginControlDocumentError("OpenCode configuration file is too large", "invalid")
    return { contents: buffer.subarray(0, offset), mode: info.mode & 0o777 }
  } finally {
    await file.close()
  }
}

function encodeOriginal(document: PluginControlDocument): Buffer {
  return Buffer.from(`${document.byteOrderMark ? "\uFEFF" : ""}${document.text}`, "utf8")
}

async function resolveWriteDestination(requestedPath: string): Promise<string> {
  let current = path.resolve(requestedPath)
  const seen = new Set<string>()
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return current
      throw new PluginControlDocumentError("Unable to inspect OpenCode configuration", "filesystem", { cause: error })
    }
    if (!info.isSymbolicLink()) return current
    if (seen.has(current)) throw new PluginControlDocumentError("OpenCode configuration symlink is circular", "filesystem")
    seen.add(current)
    const target = await readlink(current)
    current = path.resolve(path.dirname(current), target)
  }
  throw new PluginControlDocumentError("OpenCode configuration symlink chain is too deep", "filesystem")
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
