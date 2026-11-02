import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import { missionConditionSchema, type MissionConfiguration } from "./launch-policy"
import { missionSourceKey, type MissionSourceCheckpoint } from "./mission-document"

type Condition = Extract<NonNullable<MissionConfiguration["launch"]["condition"]>, { kind: "branch-commits" | "files-changed" }>
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const same = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
const fileProof = z.object({ files: z.array(z.object({ path: z.string().min(1).max(4096),
  digest: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(128), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const unknown = (): never => { throw new Error("Mission local source unavailable or changed") }
const execute = promisify(execFile)

/** Await revalidate under document exclusion immediately before publication.
 * current is an I/O-free lifetime guard; external writers can race the final read. */
export async function readMissionLocalSource(input: Condition, root: string, previous?: MissionSourceCheckpoint, signal?: AbortSignal) {
  const condition = missionConditionSchema.parse(input) as Condition
  if (!path.isAbsolute(root) || condition.kind === "branch-commits" && path.resolve(condition.directory) !== path.resolve(root)) unknown()
  const expires = performance.now() + 10_000
  let timedOut = false
  const check = () => { signal?.throwIfAborted(); if (timedOut || performance.now() >= expires) unknown() }
  const io = async <T>(operation: () => Promise<T>): Promise<T> => { check(); const value = await operation(); check(); return value }
  // Race the whole scope, including open/close. A late kernel completion resumes
  // only to check cancellation and close its handle; Promise.race observes errors.
  const bounded = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    check()
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", abort, { once: true })
    let rejectAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener("abort", rejectAbort, { once: true })
    })
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Mission local source deadline exceeded")) }, Math.max(1, expires - performance.now()))
    try { const value = await Promise.race([operation(controller.signal), aborted]); check(); return value }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", rejectAbort)
    }
  }
  const identity = async (file: string) => {
    const stat = await io(() => fs.lstat(file, { bigint: true }))
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino <= 0n) unknown()
    return { path: await io(() => fs.realpath(file)), dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) }
  }
  const rootIdentity = async () => {
    for (let parent = root; path.dirname(parent) !== parent; parent = path.dirname(parent))
      if ((await io(() => fs.lstat(parent))).isSymbolicLink()) unknown()
    return identity(root)
  }
  const git = async (args: string[], signal: AbortSignal, absent = false): Promise<string | undefined> => {
    check()
    // Ignore inherited repository redirection; always read this owned worktree.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")))
    try {
      return (await io(() => execute("git", ["--no-optional-locks", "-C", root, ...args], { env: { ...env, GIT_NO_LAZY_FETCH: "1",
         GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, timeout: Math.max(1, Math.floor(expires - performance.now())),
        maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true, signal, killSignal: "SIGKILL" }))).stdout.trim()
    } catch (error) { check(); if (absent && (error as { code?: number }).code === 1) return undefined; return unknown() }
  }
  const placement = async (signal: AbortSignal) => {
    const rootProof = await rootIdentity()
    return condition.kind === "branch-commits" ? { root: rootProof,
      top: await identity((await git(["rev-parse", "--show-toplevel"], signal))!), common: await identity((await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], signal))!),
      worktree: await identity((await git(["rev-parse", "--absolute-git-dir"], signal))!) } : { root: rootProof }
  }
  return bounded(async signal => {
    const physical = await placement(signal), rootProof = physical.root
    if (condition.kind === "branch-commits" && physical.top!.path !== rootProof.path) unknown()
    const placementDigest = hash(canonicalAuthority(physical)), key = missionSourceKey(condition)
    if (previous && (previous.key !== key || previous.kind !== condition.kind || previous.placementDigest !== placementDigest)) unknown()
    if (previous && condition.kind === "files-changed") {
      const proof = fileProof.parse(previous.value)
      if (!same(proof.files.map(file => file.path), [...condition.paths].sort()) || proof.digest !== hash(canonicalAuthority(proof.files, 32 * 1024))) unknown()
    }
    const readFiles = async () => {
      if (condition.kind !== "files-changed") return unknown()
      let total = 0
      const files = []
      for (const relative of [...condition.paths].sort()) {
        check()
        let file = root, missing = false
        const parts = relative.split("/")
        for (const [index, part] of parts.entries()) {
          // Windows alternate streams, reserved devices and trailing-dot aliases.
          if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) unknown()
          file = path.join(file, part)
          if (missing) continue
          try {
            const stat = await io(() => fs.lstat(file))
            if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory() || index === parts.length - 1 && !stat.isFile()) unknown()
          } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true; else throw error }
        }
        if (missing) { files.push({ path: relative, digest: null }); continue }
        check()
        // Enter finally before checking a late open, so cancellation cannot leak it.
        const fd = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const before = await io(() => fd.stat({ bigint: true })), named = await io(() => fs.lstat(file, { bigint: true }))
          if (!before.isFile() || named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino || before.size > 1024n * 1024n) unknown()
          const bytes = Buffer.alloc(Number(before.size) + 1)
          let length = 0
          while (length < bytes.length) { const { bytesRead: n } = await io(() => fd.read(bytes, length, bytes.length - length, null)); if (!n) break; length += n }
          total += length
          if (length !== Number(before.size) || total > 16 * 1024 * 1024) unknown()
          const after = await io(() => fd.stat({ bigint: true })), now = await io(() => fs.lstat(file, { bigint: true }))
          if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.size !== before.size
            || now.isSymbolicLink() || now.ino !== before.ino || now.dev !== before.dev) unknown()
          files.push({ path: relative, digest: hash(bytes.subarray(0, length)) })
        } finally { await fd.close() }
      }
      return files
    }
    const snapshot = async (signal: AbortSignal) => {
      check()
      if (!same(await placement(signal), physical)) unknown()
      if (condition.kind === "files-changed") {
        const files = await readFiles()
        if (!same(await rootIdentity(), rootProof)) unknown()
        return { files, digest: hash(canonicalAuthority(files, 32 * 1024)) }
      }
      const oid = (await git(["rev-parse", "--verify", `${condition.ref}^{commit}`], signal))!
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) unknown()
      return { oid }
    }
    const value = await snapshot(signal)
    if (condition.kind === "branch-commits" && previous) {
      const old = previous.value as { oid?: unknown }
      if (typeof old?.oid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(old.oid)) unknown()
      if (old.oid !== value.oid && await git(["merge-base", "--is-ancestor", old.oid as string, value.oid!], signal, true) === undefined) unknown()
    }
    let ready = true
    const current = (): true => { check(); if (!ready) unknown(); return true }
    const revalidate = async (): Promise<void> => {
      current(); ready = false
      await bounded(async signal => { if (!same(await snapshot(signal), value)) unknown() })
      ready = true
      current()
    }
    if (!same(await snapshot(signal), value)) unknown() // Complete second byte read, including parent placement.
    const checkpoint: MissionSourceCheckpoint = { key, kind: condition.kind, placementDigest, value: JSON.parse(canonicalAuthority(value)) }
    return { checkpoint, changed: !!previous && !same(previous.value, value), current, revalidate }
  })
}
