import fs from "node:fs"
import { parse as parseYaml } from "yaml"
import { isPlainObject } from "./merge-patch"

const MAX_CONFIG_BYTES = 1024 * 1024

/**
 * Authoritative boolean settings for access decisions: the configuration file as it
 * is now, never the display cache. The file is parsed again only when its stat signature
 * changes, so a per-request read costs one stat. A missing, unreadable, oversized, non-file or
 * invalid document reads every flag as false.
 */
export class ServerFlagReader {
  private signature: string | null = null
  private document: Record<string, unknown> = {}

  constructor(private readonly filePath: string) {}

  enabled(key: string, owner: readonly string[] = ["server"]): boolean {
    let stat: fs.BigIntStats
    try {
      stat = fs.statSync(this.filePath, { bigint: true })
    } catch {
      this.signature = null
      this.document = {}
      return false
    }
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    if (signature !== this.signature) {
      // Read after stat: a write in between yields newer content under the older signature,
      // which the next call's stat replaces.
      const server = readDocument(this.filePath, stat)
      // A failed read (a transient lock, for example) reads as false and is retried on the
      // next call instead of being cached under this signature.
      this.document = server ?? {}
      this.signature = server ? signature : null
    }
    let value: unknown = this.document
    for (const part of [...owner, key]) value = isPlainObject(value) ? value[part] : undefined
    return value === true
  }
}

/** The configuration document, `{}` when unusable, or null when reading failed. */
function readDocument(filePath: string, stat: fs.BigIntStats): Record<string, unknown> | null {
  if (!stat.isFile() || stat.size > BigInt(MAX_CONFIG_BYTES)) return {}
  let text: string
  try {
    text = fs.readFileSync(filePath, "utf-8")
  } catch {
    return null
  }
  try {
    const doc: unknown = parseYaml(text)
    return isPlainObject(doc) ? doc : {}
  } catch {
    return {}
  }
}
