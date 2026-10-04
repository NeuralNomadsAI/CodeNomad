// Atomic directory claim shared by cooperating brokers, independent of profile/DB.
// PID freshness is diagnostic only: no timed expiry, PID-only stealing or stale removal.
import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

export async function familyIdentity(project) {
  const root = await realpath(project)
  const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", windowsHide: true }).trim()
  const physical = await realpath(common)
  return process.platform === "win32" ? physical.toLowerCase() : physical
}
export async function claimFamily(directory, family, profileID) {
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, `${createHash("sha256").update(family).digest("hex")}.owner`)
  try { await mkdir(target) }
  catch (error) { if (error.code === "EEXIST") throw new Error("Family ownership conflict"); throw error }
  const ownerFile = path.join(target, "owner.json")
  const owner = { version: 1, family, profileID, pid: process.pid, token: randomUUID() }
  await writeFile(ownerFile, JSON.stringify(owner), { flag: "wx", mode: 0o600 })
  let released = false
  return {
    owner,
    async assertCurrent() {
      if (released || JSON.stringify(JSON.parse(await readFile(ownerFile, "utf8"))) !== JSON.stringify(owner)) throw new Error("Family claim changed")
    },
    async release() {
      await this.assertCurrent()
      // Narrow deletion only of this exact owned marker, never recursive or a scan.
      await unlink(ownerFile)
      await rmdir(target)
      released = true
    },
  }
}
export async function inspectFamily(directory, family) {
  const target = path.join(directory, `${createHash("sha256").update(family).digest("hex")}.owner`, "owner.json")
  const owner = JSON.parse(await readFile(target, "utf8"))
  let pidAlive = true
  try { process.kill(owner.pid, 0) } catch (error) { if (error.code === "ESRCH") pidAlive = false }
  return { owner, pidAlive, reclaim: "explicit-offline-only" }
}
