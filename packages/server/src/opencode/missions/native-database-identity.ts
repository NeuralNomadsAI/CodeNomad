import { lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { authorityDigest } from "../../missions/authority-protocol"
import { physical } from "../../missions/host-authority/private-files"

/** Same physical native SQLite identity used by managed-owner enrollment and
 * recurrence authority. Never hash a caller's unverified file string. */
export function nativeDatabaseIdentity(file: string) {
  if (!path.isAbsolute(file) || physical(realpathSync(file)) !== physical(file)) throw new Error("Native database path changed")
  const stat = lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino === 0n) throw new Error("Native database identity unavailable")
  return { file: physical(file), dev: String(stat.dev), ino: String(stat.ino), birthtime: String(stat.birthtimeNs) }
}

export function nativeDatabaseStorageID(file: string): string {
  return authorityDigest(nativeDatabaseIdentity(file))
}
