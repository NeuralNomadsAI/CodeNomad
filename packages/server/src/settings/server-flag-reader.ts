import fs from "node:fs"
import { parseDocument } from "yaml"
import { isPlainObject } from "./merge-patch"

const MAX_CONFIG_BYTES = 1024 * 1024

/**
 * Authoritative boolean settings for access decisions: the configuration file as it
 * is now, never the display cache. The file is parsed again only when its stat signature
 * changes, so a per-request read costs one stat. Defaults apply only to missing
 * settings; unreadable, oversized, non-file or invalid documents read as false.
 */
export class ServerFlagReader {
  private signature: string | null = null
  private document: Record<string, unknown> | null = null

  constructor(private readonly filePath: string) {}

  enabled(key: string, owner: readonly string[] = ["server"], defaultValue = false): boolean {
    let stat: fs.BigIntStats
    try {
      stat = fs.statSync(this.filePath, { bigint: true })
    } catch (error) {
      this.signature = null
      this.document = null
      return (error as NodeJS.ErrnoException).code === "ENOENT" && defaultValue
    }
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    if (signature !== this.signature) {
      // Read after stat: a write in between yields newer content under the older signature,
      // which the next call's stat replaces.
      const server = readDocument(this.filePath, stat)
      // A failed read (a transient lock, for example) reads as false and is retried on the
      // next call instead of being cached under this signature.
      this.document = server ?? null
      this.signature = server === undefined ? null : signature
    }
    let value: unknown = this.document
    for (const part of [...owner, key]) {
      if (value === undefined) return defaultValue
      if (!isPlainObject(value)) return false
      value = value[part]
    }
    return value === undefined ? defaultValue : value === true
  }
}

/** The configuration document, null when invalid, or undefined for a retryable read failure. */
function readDocument(filePath: string, stat: fs.BigIntStats): Record<string, unknown> | null | undefined {
  if (!stat.isFile() || stat.size > BigInt(MAX_CONFIG_BYTES)) return null
  let text: string
  try {
    text = fs.readFileSync(filePath, "utf-8")
  } catch {
    return undefined
  }
  try {
    const parsed = parseDocument(text, { logLevel: "silent", prettyErrors: false })
    if (parsed.errors.length) return null
    if (parsed.contents === null) return {}
    const doc: unknown = parsed.toJS()
    return isPlainObject(doc) ? doc : null
  } catch {
    return null
  }
}
