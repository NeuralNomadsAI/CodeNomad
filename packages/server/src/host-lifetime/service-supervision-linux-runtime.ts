import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, open, link, rm, chmod } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { privateStorage, type StoragePolicy } from "./storage"
import { SupervisionError } from "./service-supervision-contract"

/** Content-addressed executable copies survive backend/package replacement. */
export async function provisionLinuxSupervisionRuntime(directory: string, policy: StoragePolicy = privateStorage,
  sources: { node: string; guard: string; nativeHelper?: string } = { node: process.execPath,
    guard: fileURLToPath(new URL("../../dist/host-lifetime/service-supervision-linux-guard.cjs", import.meta.url)) }) {
  const root = path.join(directory, "runtime")
  await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
  await policy.verify(root, true)
  const result = {} as { node: string; guard: string; nativeHelper?: string }
  for (const key of ["node", "guard", "nativeHelper"] as const) {
    const source = sources[key]
    if (!source) continue
    const stat = await lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new SupervisionError("unsafe-storage")
    const bytes = await readFile(source)
    if (bytes.length !== stat.size) throw new SupervisionError("conflict")
    const hash = createHash("sha256").update(bytes).digest("hex"), file = path.join(root, hash + (key === "guard" ? ".cjs" : ""))
    try { await lstat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const temporary = path.join(root, `${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, "wx", 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        if (key !== "guard") await chmod(temporary, 0o700)
        await policy.verify(temporary, false)
        await link(temporary, file).catch(error => { if (error.code !== "EEXIST") throw error })
      } finally { await rm(temporary, { force: true }) }
    }
    await policy.verify(file, false)
    if (createHash("sha256").update(await readFile(file)).digest("hex") !== hash) throw new SupervisionError("conflict")
    result[key] = file
  }
  return result
}
