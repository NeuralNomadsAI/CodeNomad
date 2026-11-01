import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { SupervisionError, supervisionTargetSchema, type SupervisionTarget, type SupervisionNamespace } from "./service-supervision-contract"
import { readNativeServiceChannel } from "../workspaces/native-service-registration"

/** Pin complete bytes, rather than a version label or a PATH command. Stable
 * rereads fence partial installs and replacements during namespace acquisition. */
async function hash(file: string, limit = 256 * 1024 * 1024): Promise<string> {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > limit) throw new SupervisionError("invalid")
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const digest = createHash("sha256"), bytes = Buffer.alloc(1024 * 1024)
    let size = 0
    while (true) {
      const read = await handle.read(bytes, 0, bytes.length, null)
      if (!read.bytesRead) break
      size += read.bytesRead
      if (size > limit) throw new SupervisionError("invalid")
      digest.update(bytes.subarray(0, read.bytesRead))
    }
    const after = await lstat(file), opened = await handle.stat()
    if (size !== before.size || [after, opened].some(stat => stat.ino !== before.ino || stat.dev !== before.dev
      || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) throw new SupervisionError("conflict")
    return digest.digest("hex")
  } finally { await handle.close() }
}
async function unlocked(file: string) {
  try { await lstat(file); throw new SupervisionError("busy") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
}

export async function acquireSupervisionTarget(binary: string, map: (file: string) => string | Promise<string> = value => value,
  windows = process.platform === "win32"): Promise<SupervisionTarget> {
  const api = windows ? path.win32 : path.posix
  if (!api.isAbsolute(binary)) throw new SupervisionError("invalid")
  const file = await map(binary)
  if (await realpath(file) !== file) throw new SupervisionError("invalid")
  const target: SupervisionTarget = { binary, provenance: "custom" }
  // Only the exact published @opencode/cli layout qualifies as npm provenance.
  const root = api.dirname(api.dirname(binary))
  if (api.basename(root) === "cli" && api.basename(api.dirname(root)) === "@opencode"
    && api.basename(api.dirname(api.dirname(root))) === "node_modules") {
    const prefix = api.dirname(api.dirname(api.dirname(root)))
    const lock = api.join(!windows && api.basename(prefix) === "lib" ? api.dirname(prefix) : prefix, ".codenomad-opencode-install.lock")
    await unlocked(await map(lock))
    const packageFile = api.join(root, "package.json"), hostPackage = await map(packageFile)
    const sha256 = await hash(hostPackage, 65536)
    const handle = await open(hostPackage, "r")
    let pkg: { name?: string; bin?: Record<string, string> }
    try {
      const bytes = Buffer.alloc(65537), read = await handle.read(bytes, 0, bytes.length, 0)
      if (read.bytesRead > 65536) throw new SupervisionError("invalid")
      pkg = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"))
    } finally { await handle.close() }
    if (pkg.name !== "@opencode/cli" || !pkg.bin || !Object.values(pkg.bin).some(relative => typeof relative === "string"
      && api.resolve(root, relative) === binary)) throw new SupervisionError("invalid")
    target.provenance = "npm"; target.package = { file: packageFile, sha256, lock }
  }
  target.sha256 = await hash(file)
  if (!await supervisionTargetReady(target, map)) throw new SupervisionError("conflict")
  return supervisionTargetSchema.parse(target)
}

export async function supervisionTargetReady(target: SupervisionTarget,
  map: (file: string) => string | Promise<string> = value => value,
  replacement?: { namespace: SupervisionNamespace; run(args: string[]): Promise<string> }): Promise<boolean> {
  try {
    if (!target.sha256) return false
    let exact = await hash(await map(target.binary)) === target.sha256
    if (target.package) {
      await unlocked(await map(target.package.lock))
      exact = await hash(await map(target.package.file), 65536) === target.package.sha256 && exact
      await unlocked(await map(target.package.lock))
    }
    if (exact) return true
    // A complete native npm upgrade may happen with CodeNomad closed. Preserve
    // its authorized package/path, then re-prove the consumed CLI namespace before
    // accepting the replacement. Custom images still need explicit publication.
    if (!replacement || target.provenance !== "npm" || !target.package) return false
    const { namespace: n, run } = replacement
    const next = await acquireSupervisionTarget(target.binary, map, n.platform === "win32")
    if (next.package?.file !== target.package.file || next.package.lock !== target.package.lock) return false
    for (const key of ["config", "state"] as const) {
      const root = await run(["debug", "paths", key])
      if (await realpath(await map(root)) !== await realpath(await map(n[`${key}Directory`]))) return false
    }
    const password = await run(["service", "get", "password"])
    if ((await readNativeServiceChannel(await map(n.configDirectory), password)).name !== n.registrationName) return false
    return supervisionTargetReady(next, map)
  } catch { return false }
}
