import fs from "node:fs"
import { parse as parseYaml } from "yaml"
import { isPlainObject } from "./merge-patch"

const MAX_CONFIG_BYTES = 1024 * 1024

/**
 * Authoritative boolean server settings for access decisions: the configuration file as it
 * is now, never the display cache. The file is parsed again only when its stat signature
 * changes, so a per-request read costs one stat. A missing, unreadable, oversized, non-file or
 * invalid document reads every flag as false.
 */
export class ServerFlagReader {
  private signature: string | null = null
  private server: Record<string, unknown> = {}

  constructor(private readonly filePath: string) {}

  enabled(key: string): boolean {
    let stat: fs.BigIntStats
    try {
      stat = fs.statSync(this.filePath, { bigint: true })
    } catch {
      this.signature = null
      this.server = {}
      return false
    }
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    if (signature !== this.signature) {
      // Read after stat: a write in between yields newer content under the older signature,
      // which the next call's stat replaces.
      this.server = readServerOwner(this.filePath, stat)
      this.signature = signature
    }
    return this.server[key] === true
  }
}

function readServerOwner(filePath: string, stat: fs.BigIntStats): Record<string, unknown> {
  if (!stat.isFile() || stat.size > BigInt(MAX_CONFIG_BYTES)) return {}
  try {
    const doc: unknown = parseYaml(fs.readFileSync(filePath, "utf-8"))
    return isPlainObject(doc) && isPlainObject(doc.server) ? doc.server : {}
  } catch {
    return {}
  }
}
