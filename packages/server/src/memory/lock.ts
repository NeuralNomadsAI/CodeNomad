import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { MemoryError } from "./model"

/** Publish a populated directory atomically; a crash can never leave an ownerless lock. */
export async function lockMemoryRepository(directory: string): Promise<() => Promise<void>> {
  const lock = `${directory}.lock`
  const nonce = randomUUID()
  const candidate = `${lock}.${nonce}`
  const owner = JSON.stringify({ pid: process.pid, nonce })
  await mkdir(candidate, { mode: 0o700 })
  try {
    await writeFile(`${candidate}/owner`, owner, { flag: "wx", mode: 0o600 })
    const deadline = Date.now() + 30_000
    for (;;) {
      if (Date.now() >= deadline) throw new MemoryError("conflict", "Memory repository is busy")
      try {
        await rename(candidate, lock)
        return async () => {
          if (await readFile(`${lock}/owner`, "utf8").catch(() => undefined) !== owner) return
          // Vacate the published name atomically before recursive cleanup: a
          // successor must never publish into a directory being emptied by rm.
          await rename(lock, candidate)
          await rm(candidate, { recursive: true })
        }
      } catch (error) {
        let previous: { pid: number; nonce: string }
        try {
          const info = await lstat(lock)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid lock")
          previous = JSON.parse(await readFile(`${lock}/owner`, "utf8"))
          if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || !/^[a-f0-9-]{36}$/.test(previous.nonce))
            throw new Error("Invalid owner")
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") {
            await new Promise(resolve => setTimeout(resolve, 20))
            continue
          }
          throw new MemoryError("conflict", "Memory repository lock is unavailable")
        }
        let dead = false
        try { process.kill(previous.pid, 0) }
        catch (probeError) { dead = (probeError as NodeJS.ErrnoException).code === "ESRCH" }
        if (dead) {
          // Keep this nonempty tombstone: concurrent reapers then cannot rename a
          // successor into the same destination. Age and PID reuse never grant ownership.
          // ponytail: retain crash markers; prune only with all writers verifiably stopped.
          await rename(lock, `${lock}.dead-${previous.nonce}`).catch(() => undefined)
        }
        if (Date.now() >= deadline) throw new MemoryError("conflict", "Memory repository is busy")
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  } finally {
    await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
  }
}
