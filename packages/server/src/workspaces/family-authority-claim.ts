import { createHash, randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { lstat, mkdir, open, opendir, realpath, rmdir, unlink } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual, TextDecoder } from "node:util"
import { privateStorage, type StoragePolicy } from "../host-lifetime/storage"
import { verifyPrivateSync } from "../host-lifetime/private-storage-sync"
import { lookupProcess, type ProcessLookup } from "../host-lifetime/process-identity"
import { readGitCommonDirectory } from "./git-common-directory"
import { readCheckoutIdentity } from "./git-worktrees"
import { runWorktreeGit as git } from "./git-process"

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

/** Conservative final-fence fallback for discovery/config contracts that cannot
 * be captured completely by createFamilyAuthorityIdentityFence. */
export function readFamilyAuthorityIdentitySync(ownedDirectory: string): string {
  return readFamilyAuthorityPlacementSync(ownedDirectory).family
}

/** One native Git snapshot separates an authorized nested folder from its
 * enclosing checkout and physical family for final synchronous write fences. */
export function readFamilyAuthorityPlacementSync(ownedDirectory: string): { family: string; checkout: string } {
  try {
    const directory = realpathSync(ownedDirectory)
    const [checkout, common] = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 8192 }).trimEnd().split(/\r?\n/)
    if (!path.isAbsolute(common) || !path.isAbsolute(checkout)) throw new Error("Git placement is not absolute")
    return { family: physicalIdentity(realpathSync(common)), checkout: physicalIdentity(realpathSync(checkout)) }
  } catch { throw new FamilyAuthorityError("family-identity-unavailable") }
}

/** Resolve with Git before acquisition, then re-read the exact physical discovery,
 * administrative and config inputs at every final fence. Includes (including
 * missing/conditional includes) retain Git's resolver: do not emulate Git config. */
export async function createFamilyAuthorityIdentityFence(ownedDirectory: string): Promise<() => string> {
  let fallback = () => readFamilyAuthorityIdentitySync(ownedDirectory)
  try {
    const environment = familyRoutingEnvironment()
    const checkout = await realpath(ownedDirectory)
    const discovery = await Promise.all([
      git(checkout, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"]),
      environment.GIT_CONFIG_NOSYSTEM === "1" ? Promise.resolve("") : git(checkout, ["var", "GIT_CONFIG_SYSTEM"]),
      git(checkout, ["var", "GIT_CONFIG_GLOBAL"]),
    ].map(task => task.catch(() => undefined)))
    if (discovery.some(value => value === undefined)) return fallback
    const [paths, system, global] = discovery as string[]
    const [rootName, commonName, gitName] = paths.split(/\r?\n/)
    const root = await realpath(rootName), common = await realpath(commonName), gitDirectory = await realpath(gitName)
    fallback = () => {
      try {
        const actual = execFileSync("git", ["-C", realpathSync(ownedDirectory), "rev-parse", "--show-toplevel",
          "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"],
        { encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 8192 }).replace(/\r?\n$/, "").split(/\r?\n/)
        if (actual.length !== 3 || actual.some((file, index) => physicalIdentity(realpathSync(file))
          !== physicalIdentity([root, common, gitDirectory][index]))) throw new Error("routing changed")
        return physicalIdentity(common)
      } catch { throw new FamilyAuthorityError("family-identity-unavailable") }
    }
    // Environment-directed discovery and redirected effective roots need Git.
    if (["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_CONFIG"].some(key => environment[key] !== undefined)) return fallback
    const relative = path.relative(root, checkout)
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return fallback
    const administrative = await readCheckoutIdentity(root)
    if (physicalIdentity(administrative.common) !== physicalIdentity(common)
      || physicalIdentity(administrative.gitDirectory) !== physicalIdentity(gitDirectory)
      || administrative.root && physicalIdentity(administrative.root) !== physicalIdentity(root)) return fallback
    const files = new Set([ownedDirectory, checkout, root, common, gitDirectory, path.join(root, ".git"),
      path.join(gitDirectory, "commondir"), path.join(gitDirectory, "gitdir"),
      path.join(common, "objects"), path.join(common, "refs")])
    const configurations = new Set([path.join(common, "config"), path.join(common, "config.worktree"), path.join(gitDirectory, "config.worktree"),
      ...[system, global].flatMap(value => value.split(/\r?\n/).filter(Boolean).map(file => path.resolve(checkout, file)))])
    // A new nested repository must revoke the fence, even if its family/root
    // happens to be inside the already verified physical checkout.
    const nested: string[] = []
    for (let directory = checkout; directory !== root; directory = path.dirname(directory)) {
      if (files.size >= 128) return fallback
      files.add(directory); files.add(path.join(directory, ".git")); nested.push(directory)
    }
    const snapshot = [...files].map(file => [file, familyFenceEntry(file)] as const)
    // Git skipped an existing nested .git entry. Its incomplete/invalid layout
    // can become discoverable in place: keep Git's resolver, not a layout parser.
    const nestedGit = new Set(nested.map(directory => path.join(directory, ".git")))
    if (snapshot.some(([file, entry]) => nestedGit.has(file) && entry !== null)) return fallback
    const configSnapshot = [...configurations].map(file => [file, familyFenceEntry(file)] as const)
    const headFile = path.join(gitDirectory, "HEAD")
    let headIdentity = familyFenceEntry(headFile, false)
    // Git reads AFTER the filesystem snapshot, so configuration/root resolution
    // cannot be captured first and then silently paired with changed inputs.
    const [resolved, config] = await Promise.all([
      git(checkout, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"]),
      git(checkout, ["config", "--null", "--list", "--includes"]),
    ])
    if (resolved !== paths || config.split("\0").some(entry => {
      const key = entry.split("\n", 1)[0].toLowerCase()
      return key === "include.path" || key.startsWith("includeif.")
    })) return fallback
    const current = (): string => {
      try {
        if (!isDeepStrictEqual(familyRoutingEnvironment(), environment)
          || snapshot.some(([file, expected]) => !isDeepStrictEqual(familyFenceEntry(file), expected))) throw new Error("changed")
        // HEAD is required for discovery, but its branch/content is not identity.
        // Metadata changes (including in-place writes) need Git's fresh routing
        // check. Adopt a legitimate update only while that exact stamp is stable;
        // every later fence still rereads it, never borrowing a cached approval.
        const head = familyFenceEntry(headFile, false)
        if (!isDeepStrictEqual(head, headIdentity)) {
          const family = fallback()
          if (!isDeepStrictEqual(familyFenceEntry(headFile, false), head)
            || !isDeepStrictEqual(familyRoutingEnvironment(), environment)
            || snapshot.some(([file, expected]) => !isDeepStrictEqual(familyFenceEntry(file), expected))) throw new Error("changed")
          headIdentity = head
          return family
        }
        // Config bytes are only a change detector, NOT an authority fingerprint.
        // ponytail: config edits retain Git instead of adding a config parser.
        // Recheck routing semantics with Git on changes; unrelated edits remain
        // valid, and newly introduced includes cannot borrow the old fast path.
        if (configSnapshot.some(([file, expected]) => !isDeepStrictEqual(familyFenceEntry(file), expected))) return fallback()
        // A nested bare repository has no .git entry. Its discovery may change
        // routing, but ordinary HEAD/branch/content writes are never fingerprinted.
        if (nested.some(directory => ["objects", "refs"].every(entry => {
          try { return statSync(path.join(directory, entry)).isDirectory() }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
        }))) return fallback()
        return physicalIdentity(common)
      } catch { throw new FamilyAuthorityError("family-identity-unavailable") }
    }
    current()
    return current
  } catch { return fallback }
}

function familyRoutingEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env)
    .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value] as const)
    .filter(([key]) => key.startsWith("GIT_") || ["HOME", "XDG_CONFIG_HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PATH"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)))
}

/** Bounded, fresh descriptor reads; directory timestamps are deliberately absent
 * because ordinary Git writes do not change the checkout's physical identity. */
function familyFenceEntry(file: string, content = true): unknown {
  let named: import("node:fs").BigIntStats
  try { named = lstatSync(file, { bigint: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
  const identity = [realpathSync(file), named.dev, named.ino, named.birthtimeNs,
    ...(content ? [] : [named.mtimeNs, named.ctimeNs, named.size])]
  if (named.isSymbolicLink()) {
    if (content && !statSync(file).isDirectory()) throw new Error("indirect Git input")
    return ["alias", ...identity]
  }
  if (named.isDirectory()) return ["directory", ...identity]
  if (!content && named.isFile()) return ["file", ...identity]
  if (!named.isFile() || named.size > 65536n) throw new Error("unbounded Git input")
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > 65536n) throw new Error("changed")
    const bytes = Buffer.alloc(65537)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size)
      if (!count) break
      size += count
    }
    const after = lstatSync(file, { bigint: true })
    if (size > 65536 || after.dev !== stat.dev || after.ino !== stat.ino || after.birthtimeNs !== stat.birthtimeNs) throw new Error("changed")
    return ["file", ...identity, bytes.subarray(0, size)]
  } finally { closeSync(fd) }
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
