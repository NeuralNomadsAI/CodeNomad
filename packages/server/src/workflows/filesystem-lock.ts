import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

interface LockOwner {
  token: string
  pid: number
  identity?: string
}

const WAIT_MS = 5_000
const STALE_MS = 30_000
const POLL_MS = 20

export async function withFilesystemLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + WAIT_MS
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, identity: await processIdentity(process.pid) }

  while (true) {
    try {
      await fs.mkdir(lockPath)
      try {
        await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf8")
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      await removeStaleLock(lockPath)
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for filesystem lock ${lockPath}`)
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  const heartbeat = setInterval(() => {
    const now = new Date()
    void fs.utimes(lockPath, now, now).catch(() => undefined)
  }, STALE_MS / 3)
  heartbeat.unref()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await releaseOwnedLock(lockPath, owner.token)
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  let stale = false
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as LockOwner
    stale = !await ownerIsAlive(owner)
  } catch {
    try {
      stale = Date.now() - (await fs.stat(lockPath)).mtimeMs >= STALE_MS
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
  if (!stale) return
  await fs.rm(lockPath, { recursive: true, force: true })
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as LockOwner
    if (owner.token === token) await fs.rm(lockPath, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function ownerIsAlive(owner: LockOwner): Promise<boolean> {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false
  if (owner.identity) {
    const identity = await processIdentity(owner.pid)
    if (identity && identity !== owner.identity) return false
  }
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  } catch {
    return undefined
  }
}
