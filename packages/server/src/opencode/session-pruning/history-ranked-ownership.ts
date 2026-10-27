import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { discoverCheckoutCommonDirectory } from "./checkout-identity"

export type DirectoryOwnership = "owned" | "foreign_directory" | "unknown_directory" | "limit"
export type CheckRankedDirectory = (directory: string, fresh?: boolean) => Promise<DirectoryOwnership>

// One request owns this cache. The final pass rereads each contributing directory
// and the caller's identity, so a checkout replaced during the scan fails closed.
export async function rankedDirectoryOwnership(root: string, signal: AbortSignal): Promise<CheckRankedDirectory> {
  const readRoot = async () => {
    try {
      const directory = await realpath(root)
      const info = await stat(directory, { bigint: true })
      if (!info.isDirectory()) throw new Error("Not a directory")
      const common = await discoverCheckoutCommonDirectory(directory, signal)
      return { directory, common, stamp: JSON.stringify([directory, String(info.dev), String(info.ino), common]) }
    } catch { signal.throwIfAborted(); return undefined }
  }
  const identity = await readRoot()
  const cache = new Map<string, DirectoryOwnership>()
  let finalRoot: ReturnType<typeof readRoot> | undefined
  const read = async (directory: string): Promise<DirectoryOwnership> => {
    try {
      if (!identity) return "unknown_directory"
      const physical = await realpath(directory)
      if (identity.common !== undefined) {
        const common = await discoverCheckoutCommonDirectory(physical, signal)
        return common === undefined ? "unknown_directory" : common === identity.common ? "owned" : "foreign_directory"
      }
      const relative = path.relative(identity.directory, physical)
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "foreign_directory"
      const common = await discoverCheckoutCommonDirectory(physical, signal, identity.directory)
      return common === undefined ? "owned" : "foreign_directory"
    } catch { signal.throwIfAborted(); return "unknown_directory" }
  }
  return async (directory, fresh = false) => {
    signal.throwIfAborted()
    if (!identity) return "unknown_directory"
    if (!cache.has(directory) && cache.size === 600) return "limit"
    if (fresh) {
      finalRoot ??= readRoot()
      if ((await finalRoot)?.stamp !== identity.stamp) return "unknown_directory"
    }
    if (fresh || !cache.has(directory)) cache.set(directory, await read(directory))
    signal.throwIfAborted()
    return cache.get(directory)!
  }
}
