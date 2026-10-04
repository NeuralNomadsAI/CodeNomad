import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { acquireFileLock, DEADLINE_MS, delay, pidAlive, readJson, requestJson } from "./protocol.mjs"

const helperDirectory = path.dirname(fileURLToPath(import.meta.url))

async function ensureAuth(file) {
  await mkdir(path.dirname(file), { recursive: true })
  try {
    const handle = await open(file, "wx", 0o600)
    await handle.writeFile(`${randomBytes(32).toString("hex")}\n`)
    await handle.close()
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }
  return (await readFile(file, "utf8")).trim()
}

async function tryAttach(registration, token, profile) {
  if (!registration || registration.profile !== profile) return null
  return requestJson(`${registration.controlUrl}/attach`, token, profile, { method: "POST", body: JSON.stringify({ client: randomUUID() }), timeout: 500 })
}

export async function attachPersistentHost({ profileDirectory, profile, sharedDaemonMarker }) {
  const registrationFile = path.join(profileDirectory, "host.json")
  const authFile = path.join(profileDirectory, "host.auth")
  const lockFile = path.join(profileDirectory, "host.lock")
  const token = await ensureAuth(authFile)
  let registration
  try { registration = await readJson(registrationFile) } catch {}
  if (registration) {
    try { return { ...(await tryAttach(registration, token, profile)), controlUrl: registration.controlUrl, token } } catch (error) {
      if (pidAlive(registration.managerPid)) throw new Error(`Live persistent host is unreachable; refusing split brain (${error.message})`)
    }
  }

  const release = await acquireFileLock(lockFile)
  try {
    try { registration = await readJson(registrationFile) } catch { registration = undefined }
    if (registration) {
      try { return { ...(await tryAttach(registration, token, profile)), controlUrl: registration.controlUrl, token } } catch (error) {
        if (pidAlive(registration.managerPid)) throw new Error(`Live persistent host is unreachable; refusing split brain (${error.message})`)
        await rename(registrationFile, `${registrationFile}.stale-${registration.generation ?? randomUUID()}`)
      }
    }
    const manager = spawn(process.execPath, [path.join(helperDirectory, "manager.mjs"), profileDirectory, profile, authFile, sharedDaemonMarker], {
      detached: true, stdio: "ignore", windowsHide: true,
    })
    manager.unref()
    const deadline = Date.now() + DEADLINE_MS
    while (Date.now() < deadline) {
      try {
        registration = await readJson(registrationFile)
        const attached = await tryAttach(registration, token, profile)
        return { ...attached, controlUrl: registration.controlUrl, token }
      } catch (error) {
        if (manager.exitCode !== null) throw new Error(`Persistent host exited during startup: ${manager.exitCode}`)
        await delay(20)
      }
    }
    throw new Error("Persistent host registration timeout")
  } finally {
    await release()
  }
}
