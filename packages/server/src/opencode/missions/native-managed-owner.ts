import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { TextDecoder } from "node:util"
import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { z } from "zod"
import { lookupProcess } from "../../host-lifetime/process-identity"
import { physical, verifyPrivateSync } from "../../missions/host-authority/private-files"
import { authorityDigest, canonicalAuthority } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { readNativeServiceRegistration } from "../../workspaces/native-service-registration"
import { assertLoopbackServiceUrl } from "../../workspaces/service-state"

const prefix = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/managed-owner`
const key = (value: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${value}`
const text = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const databaseSchema = z.object({ file: text, dev: text, ino: text, birthtime: text }).strict()
const registrationSchema = z.object({ id: z.string().uuid(), version: text, url: text,
  pid: z.number().int().positive().safe(), password: z.string().min(1).max(1024) }).strict()
const enrollmentSchema = z.object({ version: z.literal(1), namespace: z.string().uuid(),
  service: registrationSchema.omit({ password: true }).extend({ registrationFile: text, configFile: text,
    executable: text, executableSha256: digest, startIdentity: text }).strict(),
  database: databaseSchema, daemonStorageID: digest }).strict()
export type NativeManagedEnrollment = z.infer<typeof enrollmentSchema>
const deny = (): never => { throw new Error("Native managed owner evidence unavailable or changed") }
const same = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const globalTag = Context.Service<never, unknown>("@opencode/Global")
const serverTag = Context.Service<never, unknown>("@opencode/server/ServerInfo")
const callable = Schema.declare<(...args: never[]) => unknown>((value): value is (...args: never[]) => unknown => Predicate.isFunction(value))
const sqlClient = Schema.declare<SqlClient.SqlClient>((value): value is SqlClient.SqlClient => Predicate.isFunction(value)
  && Predicate.hasProperty(value, "unsafe") && Predicate.isFunction(value.unsafe)
  && Predicate.hasProperty(value, "transactionService") && Context.isKey(value.transactionService))
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))

/** Existing protected-file policy, bounded descriptor read, no links or registry
 * creation. This is a trusted provisioning path, never an RPC/model parameter. */
function privateJSON(file: string): unknown {
  verifyPrivateSync(path.dirname(file), true); verifyPrivateSync(file, false)
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd), named = lstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 || stat.ino !== named.ino || stat.dev !== named.dev) deny()
    const bytes = Buffer.alloc(64 * 1024 + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size)
      if (!count) break
      size += count
    }
    if (size > 64 * 1024) deny()
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)))
  } catch { return deny() } finally { closeSync(fd) }
}
function databaseIdentity(file: string) {
  if (!path.isAbsolute(file) || physical(realpathSync(file)) !== physical(file)) deny()
  // Privacy is checked on the directory, not by reading/opening the database.
  verifyPrivateSync(path.dirname(file), true)
  const stat = lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino === 0n) deny()
  return databaseSchema.parse({ file: physical(file), dev: String(stat.dev), ino: String(stat.ino), birthtime: String(stat.birthtimeNs) })
}
function executableDigest(file: string) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) deny()
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}
/** Same start-identity encoding as lookupProcess; synchronous because the final
 * native metadata hook cannot accept an async liveness snapshot. Self only. */
function currentStartIdentity(): string {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8")
    const ticks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    if (!ticks || !boot) deny()
    return `linux:${boot}:${ticks}`
  }
  if (process.platform !== "win32") deny()
  const executable = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
  const script = `try { $p = [System.Diagnostics.Process]::GetProcessById(${process.pid}); 'LIVE:' + $p.StartTime.ToUniversalTime().Ticks } catch { 'UNKNOWN' }`
  const result = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 3000, maxBuffer: 4096, encoding: "utf8" }).trim()
  if (!/^LIVE:\d+$/.test(result)) deny()
  return `win32:${result.slice(5)}`
}

/** Read-only managed identity observation for explicit trusted provisioning.
 * The only write is a fresh own-plugin storage challenge, not enrollment,
 * namespace creation, signer authority or a service start. No secret escapes. */
export const observeNativeManagedOwner = Effect.fn("missions.observeNativeManagedOwner")(function* (ctx: Pick<Plugin.Context, "storage">) {
  const global = yield* Effect.serviceOption(globalTag), server = yield* Effect.serviceOption(serverTag), database = yield* Effect.serviceOption(databaseTag)
  if (Option.isNone(global) || Option.isNone(server) || Option.isNone(database)) return yield* Effect.fail(new Error("Native managed owner graph unavailable"))
  const paths = yield* Schema.decodeUnknownEffect(Schema.Struct({ state: Schema.String, config: Schema.String }))(global.value)
  const info = yield* Schema.decodeUnknownEffect(Schema.Struct({ urls: callable }))(server.value)
  const shape = yield* Schema.decodeUnknownEffect(Schema.Struct({ db: Schema.Struct({ $client: sqlClient }) }))(database.value)
  const client = shape.db.$client
  const graph = yield* Effect.context<never>()
  const read = (sql: string, params: readonly unknown[] = []) => client.unsafe(sql, params).withoutTransform.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(graph))
  // Native source selects its channel record; bounded discovery requires exactly
  // one record for THIS process, never "some service" opening the same database.
  const names = yield* Effect.tryPromise(() => import("node:fs/promises").then(fs => fs.readdir(paths.state)))
  const candidates = names.filter(name => /^service(?:-[a-zA-Z0-9._-]+)?\.json$/.test(name))
  if (candidates.length > 64) deny()
  const own = candidates.flatMap(name => {
    const file = path.join(paths.state, name), value = registrationSchema.parse(privateJSON(file))
    return value.pid === process.pid ? [{ file, value }] : []
  })
  if (own.length !== 1) deny()
  const { file: registrationFile, value: registration } = own[0]!
  const configFile = path.join(paths.config, path.basename(registrationFile))
  const config = z.object({ password: z.string() }).passthrough().parse(privateJSON(configFile))
  if (config.password !== registration.password) deny()
  const discovered = yield* Effect.tryPromise(() => readNativeServiceRegistration({ stateDirectory: paths.state,
    configDirectory: paths.config, password: registration.password }))
  if (discovered?.pid !== process.pid || discovered.url !== registration.url) deny()
  const url = assertLoopbackServiceUrl(registration.url).href
  const urls = info.urls()
  if (!Array.isArray(urls) || !urls.some(item => typeof item === "string" && assertLoopbackServiceUrl(item).href === url)) deny()
  const processState = yield* Effect.tryPromise(() => lookupProcess(process.pid))
  if (processState.state !== "live" || processState.startIdentity !== currentStartIdentity()) deny()
  const nativeDatabases = yield* read("PRAGMA database_list")
  if (nativeDatabases.length !== 1 || nativeDatabases[0]?.name !== "main" || typeof nativeDatabases[0].file !== "string") deny()
  const identity = databaseIdentity(z.string().parse(nativeDatabases[0]!.file))
  const namespace = z.string().uuid().parse(yield* ctx.storage.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`))
  const challengeKey = `${prefix}/challenges/${authorityDigest({ namespace, registrationID: registration.id })}`, nonce = randomUUID()
  yield* ctx.storage.set(challengeKey, nonce)
  const marker = yield* read("SELECT value FROM kv WHERE key=?", [key(challengeKey)])
  if (marker.length !== 1 || marker[0]?.value !== JSON.stringify(nonce)) deny()
  const { password: _password, ...safe } = registration
  const enrollment = enrollmentSchema.parse({ version: 1, namespace, service: { ...safe, registrationFile: physical(registrationFile),
    configFile: physical(configFile), executable: physical(realpathSync(process.execPath)), executableSha256: executableDigest(process.execPath),
    startIdentity: currentStartIdentity() }, database: identity, daemonStorageID: authorityDigest(identity) })
  return { enrollment, storageChallengeVerified: true as const }
}, effect => effect.pipe(Effect.catchCause(() => Effect.fail(new Error("Native managed owner evidence unavailable or changed")))))

/** Exact-incarnation candidate. No PID/TTL takeover or restart re-enrollment.
 * Compose assertCurrent with the frozen metadata provider's native nonce/claim
 * fence; neither this service record nor DB inode is independent rollback proof.
 * This excludes cooperative competing processes, NOT arbitrary native writers. */
export const acquireNativeManagedOwner = Effect.fn("missions.acquireNativeManagedOwner")(function* (
  ctx: Pick<Plugin.Context, "storage">, protectedEnrollmentFile: string,
) {
  try {
    const pinned = enrollmentSchema.parse(privateJSON(protectedEnrollmentFile))
    const observed = yield* observeNativeManagedOwner(ctx)
    if (!same(pinned, observed.enrollment)) deny()
    // Credential pinning is private capability memory, never the enrollment,
    // return value, RPC, diagnostic, prompt or an additional HTTP auth store.
    const credential = registrationSchema.parse(privateJSON(pinned.service.registrationFile)).password
    let active = true
    yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
    const assertCurrent = (): true => {
      try {
        if (!active || !same(enrollmentSchema.parse(privateJSON(protectedEnrollmentFile)), pinned)) deny()
        const current = registrationSchema.parse(privateJSON(pinned.service.registrationFile))
        const { password, ...safe } = current
        const expected = { id: pinned.service.id, version: pinned.service.version, url: pinned.service.url, pid: pinned.service.pid }
        const config = z.object({ password: z.string() }).passthrough().parse(privateJSON(pinned.service.configFile))
        if (!same(safe, expected) || password !== credential || password !== config.password || current.pid !== process.pid
          || currentStartIdentity() !== pinned.service.startIdentity || physical(realpathSync(process.execPath)) !== pinned.service.executable
          || executableDigest(process.execPath) !== pinned.service.executableSha256
          || !same(databaseIdentity(pinned.database.file), pinned.database)) deny()
        return true
      } catch { return deny() }
    }
    assertCurrent()
    return Object.freeze({ daemonStorageID: pinned.daemonStorageID, namespace: pinned.namespace, assertCurrent })
  } catch { return yield* Effect.fail(new Error("Native managed owner evidence unavailable or changed")) }
})
