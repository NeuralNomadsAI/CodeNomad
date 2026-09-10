import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile, utimes } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PRESENCE_INTERVAL_MS } from "./session-pruning/presence"

export interface PruningPaths {
  config: string
  data: string
  // WSL uses Linux paths in the entry, UNC paths only for host filesystem I/O.
  nativeData?: string
}
const marker = "// Managed by CodeNomad: session pruning lifecycle v1\n"

export async function installPruningPresence(bundle: Uint8Array, paths: PruningPaths) {
  const hash = createHash("sha256").update(bundle).digest("hex")
  const directory = path.join(paths.data, "session-pruning")
  const nativeDirectory = paths.nativeData ? path.posix.join(paths.nativeData, "session-pruning") : directory
  const leases = path.join(directory, "presence")
  const nativeLeases = paths.nativeData ? path.posix.join(nativeDirectory, "presence") : leases
  const plugin = path.join(directory, `${hash}.mjs`)
  const nativeUrl = new URL("file:///")
  nativeUrl.pathname = `${nativeDirectory}/${hash}.mjs`
  const pluginUrl = paths.nativeData ? nativeUrl.href : pathToFileURL(plugin).href
  const entry = path.join(paths.config, "plugins", "codenomad-session-pruning.ts")
  const source = `${marker}import { desktopPlugin } from ${JSON.stringify(pluginUrl)}\nexport default desktopPlugin(${JSON.stringify(nativeLeases)})\n`
  await mkdir(leases, { recursive: true })
  await mkdir(path.dirname(entry), { recursive: true })
  const existing = await readFile(entry, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (existing && !existing.startsWith(marker)) throw new Error(`Existing plugin entry is not managed by CodeNomad: ${entry}`)
  // Immutable, content-addressed payloads keep running instances independent of upgrades.
  await writeFile(plugin, bundle, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const lease = path.join(leases, `${randomUUID()}.lease`)
  await writeFile(lease, "")
  try {
    if (existing !== source) {
      const temporary = `${entry}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, source)
        await rename(temporary, entry)
      } finally { await rm(temporary, { force: true }) }
    }
  } catch (error) {
    await rm(lease, { force: true })
    throw error
  }
  let pending = Promise.resolve()
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      const now = new Date()
      await utimes(lease, now, now)
    }).catch(() => {})
  }, PRESENCE_INTERVAL_MS)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await pending
    await rm(lease, { force: true })
  }
}
