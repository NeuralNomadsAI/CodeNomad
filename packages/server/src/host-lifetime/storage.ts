import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { HostError, MAX_BYTES, validateOwner, validateRegistration, type Owner, type Registration, type Scope } from "./protocol"
import { ownerState, type ProcessLookup } from "./process-identity"
import { windowsPrivateStorage } from "./windows-storage"

export interface StoragePolicy {
  /** Windows must check the DACL/owner of the private directory and each file.
   * Unix default verifies UID/mode. The parent root must be provisioned privately. */
  verify(file: string, directory: boolean): Promise<void>
}
interface OwnerRecord { owner: Owner; generation: string }
function validateGeneration(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new HostError("invalid-owner-generation")
}
export const privateStorage: StoragePolicy = {
  async verify(file, directory) {
    const stat = await lstat(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1))
      throw new HostError("unsafe-storage-type")
    if (process.platform === "win32") return windowsPrivateStorage.verify(file, directory)
    if (!process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
      throw new HostError("unsafe-storage-permissions")
  },
}
export class HostStorage {
  readonly directory: string
  constructor(root: string, readonly scope: Scope, private readonly policy = privateStorage) {
    this.directory = path.join(path.resolve(root), scope.key)
  }
  private file(name: string): string { return path.join(this.directory, name) }
  async initialize(): Promise<void> {
    const root = path.dirname(this.directory)
    // Reject symlink/reparse ancestors rather than following an alternate registry.
    let ancestor = root
    while (true) {
      const stat = await lstat(ancestor)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HostError("unsafe-storage-ancestor")
      const parent = path.dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    await this.policy.verify(root, true)
    await mkdir(this.directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
    await this.policy.verify(this.directory, true)
  }
  async read<T>(name: string): Promise<T | undefined> {
    const file = this.file(name)
    try { await this.policy.verify(file, false) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      const named = await lstat(file)
      if (stat.ino !== named.ino || stat.dev !== named.dev || stat.size > MAX_BYTES || !stat.isFile()) throw new HostError("unsafe-storage-read")
      try { return JSON.parse(await handle.readFile("utf8")) as T } catch { throw new HostError("malformed-storage") }
    } finally { await handle.close() }
  }
  async registration(): Promise<Registration | undefined> {
    const registration = await this.read<Registration>("host.json")
    if (registration !== undefined) validateRegistration(registration, this.scope)
    return registration
  }
  async ownerRecord(): Promise<OwnerRecord | undefined> {
    const value = await this.read<OwnerRecord>("owner.json")
    if (value === undefined) return undefined
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HostError("invalid-owner")
    validateOwner(value.owner)
    validateGeneration(value.generation)
    return value
  }
  async secret(generation: string): Promise<string> {
    const value = await this.read<unknown>(`${generation}.secret`)
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new HostError("invalid-host-secret")
    return value
  }
  async atomic(name: string, value: unknown): Promise<void> {
    const temporary = this.file(`${randomUUID()}.tmp`)
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    try {
      await this.policy.verify(temporary, false)
      await rename(temporary, this.file(name))
    } finally { await rm(temporary, { force: true }) }
  }
  /** All claim/reclaim decisions share a short exclusive gate. A crashed gate is
   * deliberately NOT stolen: without a native lock primitive there is no safe CAS.
   * It requires explicit operator recovery, never a timeout/PID guess. */
  async claim(owner: Owner, generation: string, lookup: ProcessLookup): Promise<boolean> {
    validateOwner(owner)
    validateGeneration(generation)
    const gate = this.file("election")
    try { await mkdir(gate, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
    try {
      const published = await this.registration()
      if (published !== undefined) {
        const state = await ownerState(published.owner, lookup)
        if (state === "unknown") throw new HostError("unknown-owner")
        if (state === "live") return false
        // Guard process disappearance is required before a second full backend.
        const backend = await ownerState(published.backend, lookup)
        if (backend !== "dead") throw new HostError("previous-backend-exit-unconfirmed")
      }
      const current = await this.ownerRecord()
      if (current !== undefined) {
        const state = await ownerState(current.owner, lookup)
        if (state === "unknown") throw new HostError("unknown-owner")
        if (state === "live") return false
        // Only the gate holder can replace this proven-dead owner.
        const registration = await this.registration()
        if (registration !== undefined && registration.generation !== current.generation) throw new HostError("ownership-conflict")
        if (registration !== undefined) await rename(this.file("host.json"), this.file(`${registration.generation}.stale`))
        if (registration !== undefined) await rm(this.file(`${registration.generation}.secret`), { force: true })
        await rename(this.file("owner.json"), this.file(`${randomUUID()}.dead-owner`))
      }
      if (published !== undefined && current === undefined) {
        await rename(this.file("host.json"), this.file(`${published.generation}.stale`))
        await rm(this.file(`${published.generation}.secret`), { force: true })
      }
      await this.atomic("owner.json", { owner, generation })
      return true
    } finally { await rmdir(gate) }
  }
  async release(generation: string): Promise<void> {
    const owner = await this.ownerRecord()
    if (owner?.generation !== generation) throw new HostError("ownership-conflict")
    const registration = await this.registration()
    if (registration?.generation === generation) await rm(this.file("host.json"))
    await rm(this.file(`${generation}.secret`), { force: true })
    await rm(this.file("owner.json"))
  }
}
