import { readdir, stat } from "node:fs/promises"
import path from "node:path"

/** Directories whose contents never take part in the daemon-served module
 * graph; mtime changes inside them must not invalidate a live daemon. */
const noiseDirectoryNames = new Set(["node_modules", ".git", ".codegraph", "dist"])

/** The daemon's staleness fingerprint: the newest mtime across the source
 * trees its transformed module graph serves. A daemon started before this
 * instant may hold pre-edit transforms and must not serve new borrowers. */
export async function newestSourceMtime(directories: string[]): Promise<number> {
  let newest = 0
  const pending: string[] = []
  for (const directory of directories) pending.push(directory)
  while (pending.length) {
    const current = pending.pop()!
    let entries: Awaited<ReturnType<typeof readdir>>
    try { entries = await readdir(current, { withFileTypes: true }) } catch { continue } // missing tree: no signal
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue
      if (noiseDirectoryNames.has(entry.name)) continue
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) {
        try { newest = Math.max(newest, (await stat(child)).mtimeMs) } catch { /* raced away */ }
      }
    }
  }
  return newest
}
