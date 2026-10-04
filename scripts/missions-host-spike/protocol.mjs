import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export const DEADLINE_MS = 12_000

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

export async function requestJson(url, token, profile, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "x-codenomad-profile": profile,
      "content-type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeout ?? 2_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { status: response.status })
  return body
}

export async function acquireFileLock(file, deadline = Date.now() + DEADLINE_MS) {
  await mkdir(path.dirname(file), { recursive: true })
  while (Date.now() < deadline) {
    try {
      const handle = await open(file, "wx", 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`)
      return async () => {
        await handle.close()
        await rm(file, { force: true })
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      let owner
      try { owner = await readJson(file) } catch {}
      if (owner && !pidAlive(owner.pid)) {
        await rm(file, { force: true })
        continue
      }
      await delay(20)
    }
  }
  throw new Error(`Timed out acquiring private host lock: ${file}`)
}

export async function exists(file) {
  try { await access(file); return true } catch { return false }
}
