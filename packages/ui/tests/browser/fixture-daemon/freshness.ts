import { readdir, stat } from "node:fs/promises"
import path from "node:path"

/** Directories excluded from the staleness walk. node_modules and dot
 * directories would make the walk unbounded and nondeterministic. `public`
 * directories hold verbatim static assets, never transformed modules — and
 * the git fixtures copy Monaco's tree into src/renderer/public at run time,
 * which on CI retired a healthy daemon the moment a git fixture ran beside
 * borrowed files (shards interleave; the tiered local runner never showed
 * it). The accepted blind spots are dependency installs and tsconfig edits
 * — every runner binds a fresh daemon per invocation anyway, so only an
 * edit made *while* a daemon serves goes unnoticed, and installs don't
 * happen there. */
const noiseDirectoryNames = new Set(["node_modules", ".git", ".codegraph", "dist", "public"])

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
