import { createHash, randomBytes } from "node:crypto"
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { lstat, mkdir, open, opendir, realpath, rmdir, unlink } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual, TextDecoder } from "node:util"
import { privateStorage, type StoragePolicy } from "../host-lifetime/storage"
import { verifyPrivateSync } from "../host-lifetime/private-storage-sync"
import { lookupProcess, type ProcessLookup } from "../host-lifetime/process-identity"
import { readGitCommonDirectory } from "./git-common-directory"

const MAX_MARKER_BYTES = 8 * 1024
type MarkerIdentity = Pick<import("node:fs").BigIntStats, "dev" | "ino" | "birthtimeNs">

export class FamilyAuthorityError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** Only call with a directory already authorized by WorkspaceManager. Git-free
 * conversations remain supported, but cannot infer a continuity family identity. */
export async function readFamilyAuthorityIdentity(ownedDirectory: string): Promise<string> {
  try { return physicalIdentity(await readGitCommonDirectory(await realpath(ownedDirectory))) }
  catch { throw new FamilyAuthorityError("family-identity-unavailable") }
}

interface Marker {
  version: 1
  family: string
  profileKey: string
  executionHostKey: string
  process: { pid: number; startIdentity: string }
  token: string
}

export interface FamilyAuthorityClaim {
  assertCurrent(): Promise<void>
  release(): Promise<void>
}
export interface SynchronousFamilyAuthorityClaim extends FamilyAuthorityClaim {
  assertCurrentSync(): true
}

/** Immutable, crash-conservative claim shared across cooperating profiles and
 * daemons. The store root is trusted, PRIVATE and preprovisioned outside profiles.
 * No TTL/PID takeover: a crashed/partial claim needs explicit offline repair.
 * Every participating family mutation must consult this same store; this module
 * does not fence old/nonparticipating clients, native jobs or arbitrary Git. */
export class FamilyAuthorityStore {
  private readonly claims = new Map<string, { marker: Marker; identity: MarkerIdentity; references: number }>()
  private tail: Promise<void> = Promise.resolve()
  // ponytail: fence the existing store-wide queue; split by family only if parallel commits need it.
  private pending = 0

  constructor(private readonly options: {
    root: string
    profileKey: string
    executionHostKey: string
    policy?: StoragePolicy & { verifySync?(file: string, directory: boolean): void }
    lookup?: ProcessLookup
  }) {
    for (const value of [options.profileKey, options.executionHostKey]) {
      if (!value || value.length > 240 || value.includes("\0")) throw new FamilyAuthorityError("invalid-family-owner")
    }
  }

  acquire(family: string): Promise<SynchronousFamilyAuthorityClaim> {
    return this.exclusive(async () => {
      if (!path.isAbsolute(family) || family.includes("\0")) throw new FamilyAuthorityError("family-identity-unavailable")
      let physical: string
      try { physical = physicalIdentity(await realpath(family)) }
      catch { throw new FamilyAuthorityError("family-identity-unavailable") }
      if (physical !== family) throw new FamilyAuthorityError("family-identity-changed")
      const retained = this.claims.get(family)
      if (retained) {
        await this.assertMarker(retained.marker)
        retained.references++
        return this.reference(retained.marker)
      }
      await this.verifyRoot()
      const processIdentity = await (this.options.lookup ?? lookupProcess)(process.pid)
      if (processIdentity.state !== "live") throw new FamilyAuthorityError("family-owner-unknown")
      const marker: Marker = { version: 1, family, profileKey: this.options.profileKey,
        executionHostKey: this.options.executionHostKey, process: { pid: process.pid, startIdentity: processIdentity.startIdentity },
        token: randomBytes(32).toString("hex") }
      if (Buffer.byteLength(JSON.stringify(marker)) > MAX_MARKER_BYTES) throw new FamilyAuthorityError("family-identity-unavailable")
      const directory = this.directory(family)
      try { await mkdir(directory, { mode: 0o700 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FamilyAuthorityError("family-owner-conflict")
        throw new FamilyAuthorityError("family-claim-unavailable")
      }
      // Verify privacy BEFORE writing the release capability. Partial publication
      // is retained, never mistaken for absence or repaired by another process.
      let identity: MarkerIdentity
      try {
        await this.policy.verify(directory, true)
        const handle = await open(path.join(directory, "owner.json"), "wx", 0o600)
        try { await handle.writeFile(JSON.stringify(marker)); await handle.sync() } finally { await handle.close() }
        identity = await this.assertMarker(marker)
      } catch { throw new FamilyAuthorityError("family-claim-unavailable") }
      this.claims.set(family, { marker, identity, references: 1 })
      return this.reference(marker)
    })
  }

  private get policy(): StoragePolicy { return this.options.policy ?? privateStorage }

  private directory(family: string): string {
    // Profile, channel, daemon namespace and execution-host IDs are deliberately
    // absent from the key: they cannot justify another owner of a physical family.
    return path.join(path.resolve(this.options.root), `${createHash("sha256").update(family).digest("hex")}.owner`)
  }

  private async verifyRoot(): Promise<void> {
    try {
      const root = path.resolve(this.options.root)
      if (physicalIdentity(await realpath(root)) !== physicalIdentity(root)) throw new Error("alias")
      await this.policy.verify(root, true)
    } catch { throw new FamilyAuthorityError("family-store-unavailable") }
  }

  private async assertMarker(marker: Marker): Promise<MarkerIdentity> {
    try {
      await this.verifyRoot()
      const directory = this.directory(marker.family)
      await this.policy.verify(directory, true)
      const file = path.join(directory, "owner.json")
      await this.policy.verify(file, false)
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await handle.stat({ bigint: true })
        const named = await lstat(file, { bigint: true })
        if (!stat.isFile() || stat.nlink !== 1n || stat.ino !== named.ino || stat.dev !== named.dev || stat.size > BigInt(MAX_MARKER_BYTES)) throw new Error("marker")
        const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1)
        let size = 0
        while (size < bytes.length) {
          const read = await handle.read(bytes, size, bytes.length - size, size)
          if (!read.bytesRead) break
          size += read.bytesRead
        }
        if (size > MAX_MARKER_BYTES || !isDeepStrictEqual(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))), marker)) throw new Error("changed")
        return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs }
      } finally { await handle.close() }
    } catch { throw new FamilyAuthorityError("family-claim-lost") }
  }

  private assertMarkerSync(marker: Marker, identity: MarkerIdentity): void {
    try {
      const root = path.resolve(this.options.root), directory = this.directory(marker.family)
      if (physicalIdentity(realpathSync(root)) !== physicalIdentity(root)
        || physicalIdentity(realpathSync(directory)) !== physicalIdentity(directory)
        || physicalIdentity(realpathSync(marker.family)) !== marker.family || !lstatSync(marker.family).isDirectory()) throw new Error("alias")
      const verify = this.options.policy ? this.options.policy.verifySync?.bind(this.options.policy) : verifyPrivateSync
      if (!verify) throw new Error("privacy")
      const file = path.join(directory, "owner.json")
      for (const [target, isDirectory] of [[root, true], [directory, true], [file, false]] as const) {
        const result: unknown = verify(target, isDirectory)
        if (result !== undefined) {
          if (result instanceof Promise) void Promise.prototype.then.call(result, undefined, () => undefined)
          throw new Error("privacy")
        }
      }
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true })
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_MARKER_BYTES)
          || stat.ino !== named.ino || stat.dev !== named.dev || stat.ino !== identity.ino
          || stat.dev !== identity.dev || stat.birthtimeNs !== identity.birthtimeNs) throw new Error("marker")
        const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1)
        let size = 0
        while (size < bytes.length) {
          const count = readSync(fd, bytes, size, bytes.length - size, size)
          if (!count) break
          size += count
        }
        if (size > MAX_MARKER_BYTES || !isDeepStrictEqual(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))), marker)) throw new Error("changed")
        const current = lstatSync(file, { bigint: true })
        if (current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1n) throw new Error("marker")
      } finally { closeSync(fd) }
    } catch { throw new FamilyAuthorityError("family-claim-lost") }
  }

  private reference(marker: Marker): SynchronousFamilyAuthorityClaim {
    let released = false, releaseRequested = false
    return {
      assertCurrentSync: () => {
        const claim = this.claims.get(marker.family)
        if (!claim) throw new FamilyAuthorityError("family-claim-lost")
        const fence = () => {
          if (released || releaseRequested || this.pending || this.claims.get(marker.family) !== claim || claim.marker !== marker) throw new FamilyAuthorityError("family-claim-lost")
        }
        fence()
        this.assertMarkerSync(marker, claim.identity)
        fence()
        return true
      },
      assertCurrent: () => this.exclusive(async () => {
        if (released) throw new FamilyAuthorityError("family-claim-lost")
        await this.assertMarker(marker)
      }),
      release: () => this.exclusive(async () => {
        // The synchronous queue counter fences this reference even before this job begins.
        releaseRequested = true
        if (released) return
        const claim = this.claims.get(marker.family)
        if (!claim || claim.marker !== marker) throw new FamilyAuthorityError("family-claim-lost")
        await this.assertMarker(marker)
        if (claim.references > 1) { claim.references--; released = true; return }
        // Delete only the exact marker we still own and its EMPTY directory.
        // Additional files prevent cleanup instead of being recursively deleted.
        const directory = this.directory(marker.family)
        try {
          const entries = await opendir(directory)
          let count = 0
          for await (const entry of entries) {
            if (++count > 1 || entry.name !== "owner.json") throw new Error("unexpected file")
          }
          if (count !== 1) throw new Error("missing marker")
          await unlink(path.join(directory, "owner.json"))
          await rmdir(directory)
        }
        catch { throw new FamilyAuthorityError("family-release-unconfirmed") }
        this.claims.delete(marker.family)
        released = true
      }),
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.pending++
    const result = this.tail.then(operation).finally(() => { this.pending-- })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

function physicalIdentity(directory: string): string {
  const normalized = path.normalize(directory)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
