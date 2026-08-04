import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

interface LockOwner {
  token: string
  pid: number
  runtimeToken?: string
  identity?: string
}

interface ObservedOwner {
  token?: string
  serialized?: string
}

const WAIT_MS = 5_000
const STALE_MS = 30_000
const POLL_MS = 20
const RUNTIME_TOKEN = randomUUID()

export async function withFilesystemLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  let deadline = Date.now() + WAIT_MS
  let staleRetryGranted = false
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, runtimeToken: RUNTIME_TOKEN, identity: await processIdentity(process.pid) }

  while (true) {
    try {
      await fs.mkdir(lockPath)
      try {
        await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf8")
        await fs.writeFile(path.join(lockPath, "heartbeat"), randomUUID(), "utf8")
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (staleRetryGranted) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for filesystem lock ${lockPath}`)
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        continue
      }
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        continue
      }
      if (await removeStaleLock(lockPath)) {
        if (!staleRetryGranted) {
          staleRetryGranted = true
          deadline = Date.now() + WAIT_MS
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        continue
      }
      throw new Error(`Timed out waiting for filesystem lock ${lockPath}`)
    }
  }

  const heartbeat = setInterval(() => {
    void fs.writeFile(path.join(lockPath, "heartbeat"), randomUUID(), "utf8").catch(() => undefined)
  }, STALE_MS / 3)
  heartbeat.unref()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await releaseOwnedLock(lockPath, owner.token)
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  let stale = false
  let observed: ObservedOwner = {}
  try {
    const serialized = await fs.readFile(path.join(lockPath, "owner.json"), "utf8")
    const owner = JSON.parse(serialized) as LockOwner
    observed = { token: owner.token, serialized }
    stale = !await ownerIsAlive(owner, lockPath)
  } catch {
    const first = await heartbeatState(lockPath)
    await new Promise((resolve) => setTimeout(resolve, STALE_MS))
    stale = await heartbeatState(lockPath) === first
  }
  if (!stale) {
    try {
      await fs.access(path.join(lockPath, ".reclaim"))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return !sameObservedOwner(await readObservedOwner(lockPath), observed)
  }

  const claimPath = path.join(lockPath, ".reclaim")
  try {
    await fs.writeFile(claimPath, JSON.stringify(observed), { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return true
    throw error
  }

  const quarantinePath = `${lockPath}.stale.${randomUUID()}`
  let moved = false
  try {
    const current = await readObservedOwner(lockPath)
    if (!sameObservedOwner(current, observed)) return true
    await fs.rename(lockPath, quarantinePath)
    moved = true
    const movedOwner = await readObservedOwner(quarantinePath)
    if (!sameObservedOwner(movedOwner, observed)) {
      await fs.rename(quarantinePath, lockPath).then(() => { moved = false }).catch(() => undefined)
      return true
    }
    await fs.rm(quarantinePath, { recursive: true, force: true })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return true
  } finally {
    if (!moved) await fs.rm(claimPath, { force: true }).catch(() => undefined)
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const deadline = Date.now() + WAIT_MS
    while (true) {
      try {
        await fs.access(path.join(lockPath, ".reclaim"))
        if (Date.now() >= deadline) return
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        break
      }
    }
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as LockOwner
    if (owner.token === token) await fs.rm(lockPath, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function readObservedOwner(lockPath: string): Promise<ObservedOwner> {
  try {
    const serialized = await fs.readFile(path.join(lockPath, "owner.json"), "utf8")
    try {
      return { token: (JSON.parse(serialized) as LockOwner).token, serialized }
    } catch {
      return { serialized }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}

function sameObservedOwner(left: ObservedOwner, right: ObservedOwner): boolean {
  return left.token !== undefined || right.token !== undefined
    ? left.token !== undefined && left.token === right.token
    : left.serialized === right.serialized
}

async function ownerIsAlive(owner: LockOwner, lockPath: string): Promise<boolean> {
  if (owner.runtimeToken === RUNTIME_TOKEN) return true
  const first = await heartbeatState(lockPath)
  const deadline = Date.now() + STALE_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())))
    try {
      const current = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as LockOwner
      if (current.token !== owner.token) return true
    } catch {
      return true
    }
    if (await heartbeatState(lockPath) !== first) return true
  }
  return false
}

async function heartbeatState(lockPath: string): Promise<string> {
  try {
    return await fs.readFile(path.join(lockPath, "heartbeat"), "utf8")
  } catch {
    try {
      return String((await fs.stat(lockPath)).mtimeMs)
    } catch {
      return "missing"
    }
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
