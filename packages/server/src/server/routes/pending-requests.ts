import type { FastifyInstance } from "fastify"
import path from "node:path"
import { lstat, realpath } from "node:fs/promises"
import { z } from "zod"
import type { FormInfo, PermissionRequest } from "@opencode/client"
import type { WorkspacePendingRequestLocation, WorkspacePendingRequestsResponse } from "../../api-types"
import { PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { readGitCommonDirectory } from "../../workspaces/git-common-directory"
import { deferPendingDiscovery, markLoadedPendingSupported, PENDING_DISCOVERY_DEFERRED } from "../../workspaces/pending-discovery"

const directorySchema = z.string().min(1).max(4096)
const directoryListSchema = z.union([directorySchema, z.array(directorySchema).min(1).max(64)])
const querySchema = z.object({ directories: directoryListSchema, optionalDirectories: directoryListSchema.optional() }).strict()
const permissionSchema = z.object({
  id: z.string(), sessionID: z.string(), action: z.string(), resources: z.array(z.string()),
  save: z.array(z.string()).optional(), metadata: z.record(z.unknown()).optional(), message: z.string().optional(),
  source: z.object({ type: z.literal("tool"), messageID: z.string(), id: z.string() }).optional(),
})
const numeric = z.union([z.number(), z.enum(["Infinity", "-Infinity", "NaN"])])
const option = z.object({ value: z.string(), label: z.string(), description: z.string().optional() })
const field = z.object({
  key: z.string(), title: z.string().optional(), description: z.string().optional(),
  required: z.boolean().optional(), hidden: z.boolean().optional(),
  when: z.array(z.object({ key: z.string(), op: z.enum(["eq", "neq"]), value: z.union([z.string(), numeric, z.boolean()]) })).optional(),
})
const fieldSchema = z.discriminatedUnion("type", [
  field.extend({ type: z.literal("string"), format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    minLength: z.number().optional(), maxLength: z.number().optional(), pattern: z.string().optional(),
    placeholder: z.string().optional(), default: z.string().optional(), options: z.array(option).optional(), custom: z.boolean().optional() }),
  field.extend({ type: z.literal("number"), minimum: numeric.optional(), maximum: numeric.optional(), default: numeric.optional() }),
  field.extend({ type: z.literal("integer"), minimum: numeric.optional(), maximum: numeric.optional(), default: numeric.optional() }),
  field.extend({ type: z.literal("boolean"), default: z.boolean().optional() }),
  field.extend({ type: z.literal("multiselect"), options: z.array(option), minItems: z.number().optional(),
    maxItems: z.number().optional(), custom: z.boolean().optional(), default: z.array(z.string()).optional() }),
  field.extend({ type: z.literal("external"), url: z.string() }),
])
const formSchema = z.object({
  id: z.string(), sessionID: z.string(), title: z.string(), metadata: z.record(z.unknown()).optional(),
  fields: z.array(fieldSchema).min(1),
})
// One backend-owned RPC; never exposed by the generic instance proxy.
const snapshotSchema = z.object({ originDirectory: directorySchema, data: z.array(
  z.object({ directory: directorySchema, status: z.literal("complete"), locations: z.array(z.object({
    location: z.object({ directory: directorySchema, workspaceID: z.string().optional() }).strict(),
    permissions: z.array(permissionSchema).max(1024), forms: z.array(formSchema).max(1024),
  })).max(64) }),
).max(64) }).strict()
const nativeSchema = z.object({ output: snapshotSchema }).strict()
const unavailableSchema = z.object({
  _tag: z.literal("RpcError"), type: z.enum(["rpc.unavailable", "rpc.method_not_found"]),
  message: z.string().min(1).max(4096),
}).strict()
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

async function drainOwnershipReads<T>(reads: Promise<T>[]): Promise<T[]> {
  try { return await Promise.all(reads) }
  catch (error) {
    // Keep custody of this batch's admitted reads before returning the first failure.
    await Promise.allSettled(reads)
    throw error
  }
}

const missingHost = (host: string) => lstat(host).then(() => false, error => (error as NodeJS.ErrnoException).code === "ENOENT")

export interface PendingRequestsRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "getServiceLocation" | "getServicePathStyle" | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath" | "getHostPathForServicePath" | "ownsLocation">
  worktreeDeletionFence: Pick<WorktreeDeletionFence, "isBlocked">
  /** Test seam only; production always uses the real Git common-directory reader. */
  readGitCommonDirectory?: typeof readGitCommonDirectory
}

export function registerPendingRequestRoutes(app: FastifyInstance, deps: PendingRequestsRouteDeps): void {
  const readCommon = deps.readGitCommonDirectory ?? readGitCommonDirectory
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/pending-requests", async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const query = querySchema.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: "Invalid pending request directories" })
    const manager = deps.workspaceManager, id = request.params.id
    const workspace = manager.get(id)
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
    // Includes bounded Git ownership reads before/after the native reader's independent two-second deadline.
    const signal = AbortSignal.timeout(PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS)
    const started = Date.now()
    let phase = "ownership"
    let nativeStatus: number | undefined
    // Phase durations only; never paths or queue contents.
    const timing: string[] = []
    let lap = started
    const record = (name: string) => {
      const now = Date.now()
      timing.push(`${name};dur=${now - lap}`)
      lap = now
      reply.header("Server-Timing", timing.join(", "))
    }
    try {
      const connection = await manager.getSharedServiceConnection(id)
      if (!connection) return reply.code(503).send({ error: "Pending requests unavailable" })
      if (deferPendingDiscovery(connection, { loadedOnly: true })) return reply.header("Retry-After", "30").code(503).send({ error: PENDING_DISCOVERY_DEFERRED })
      const submitted = [...new Set(typeof query.data.directories === "string" ? [query.data.directories] : query.data.directories)]
      const optional = new Set(typeof query.data.optionalDirectories === "string" ? [query.data.optionalDirectories] : query.data.optionalDirectories ?? [])
      if ([...optional].some((directory) => !submitted.includes(directory))) return reply.code(400).send({ error: "Invalid optional pending request directories" })
      const result: Extract<WorkspacePendingRequestsResponse, { supported: true }> = { supported: true, directories: [] }
      const resolved: Array<{ submitted: string; directory: string; identity: string }> = []
      // Optional history whose host directory is absent: authorized by its own owned
      // identity or by an existing, canonically owned ancestor, and revalidated after RPC.
      const missing: Array<{ submitted: string; directory?: string; identity: string; host: string; ancestor?: string }> = []
      // A candidate whose ownership cannot be (re)established reports its own
      // non-authoritative error; it neither fails the batch nor counts as empty.
      const failed = new Set<string>()
      const bootstrap = manager.getServiceLocation(id)
      const style = manager.getServicePathStyle(id)
      const nativePath = style === "win32" ? path.win32 : style === "posix" ? path.posix : undefined
      const root = await manager.getServiceDirectoryForPath(id, workspace.path)
      const rootIdentity = bootstrap && await manager.getWorktreeIdentityForPath(id, bootstrap.directory)
      if (!bootstrap || bootstrap.workspaceID !== undefined || !root || !rootIdentity || !nativePath?.isAbsolute(bootstrap.directory)
        || await manager.getServiceDirectoryForPath(id, bootstrap.directory) !== root) throw new Error("Pending bootstrap unavailable")
      const bootstrapDirectory = bootstrap.directory
      const isolate = (error: unknown) => {
        if (signal.aborted) throw error
      }
      let common: Promise<string> | undefined
      const workspaceCommon = () => common ??= readCommon(workspace.path)
      // Lazy: the expected identity is read only once an existing ancestor needs it.
      const ownedMissingAncestor = async (candidate: string, expectedCommon: () => Promise<string>) => {
        if (!nativePath.isAbsolute(candidate)) return undefined
        let ancestor = candidate
        // Only an existing, canonically owned ancestor can authorize an absent hint.
        for (let depth = 0; depth < 64; depth++) {
          signal.throwIfAborted()
          const host = await manager.getHostPathForServicePath(id, ancestor)
          if (!host || !path.isAbsolute(host)) return undefined
          if (!await missingHost(host)) {
            const directory = await manager.getServiceDirectoryForPath(id, ancestor)
            const identity = directory && await manager.getWorktreeIdentityForPath(id, directory)
            const canonical = directory && await manager.getHostPathForServicePath(id, directory)
            if (!identity || !canonical || deps.worktreeDeletionFence.isBlocked(identity)) return undefined
            try {
              if (await realpath(host) !== await realpath(canonical)
                || await readCommon(host) !== await expectedCommon()) return undefined
            } catch { return undefined }
            return { ancestor, identity }
          }
          const parent = nativePath.dirname(ancestor)
          if (parent === ancestor) break
          ancestor = parent
        }
        return undefined
      }
      // ponytail: eight ownership checks at a time keep bounded Windows Git reads inside the request deadline.
      for (let offset = 0; offset < submitted.length; offset += 8) {
        const candidates = await drainOwnershipReads(submitted.slice(offset, offset + 8).map(async (candidate) => {
          signal.throwIfAborted()
          try {
            const directory = await manager.getServiceDirectoryForPath(id, candidate)
            if (!directory && optional.has(candidate)) {
              const host = await manager.getHostPathForServicePath(id, candidate)
              const owned = host && path.isAbsolute(host) && await missingHost(host) ? await ownedMissingAncestor(candidate, workspaceCommon) : undefined
              if (!host || !owned) return { candidate, status: "error" as const }
              return { candidate, status: "excluded" as const, missing: { submitted: candidate, host, ...owned } }
            }
            const identity = directory === root ? rootIdentity : directory && await manager.getWorktreeIdentityForPath(id, directory)
            const host = directory && await manager.getHostPathForServicePath(id, directory)
            if (!directory || !identity || !host || deps.worktreeDeletionFence.isBlocked(identity)) return { candidate, status: "error" as const }
            // An owned optional path whose checkout is already gone is excluded history,
            // still fenced by its identity and revalidated as absent after RPC.
            if (directory !== root && optional.has(candidate) && await missingHost(host)) {
              return { candidate, status: "excluded" as const, missing: { submitted: candidate, directory, identity, host } }
            }
            // Containment alone cannot authorize a nested independent clone.
            const sameRepository = directory === root || await Promise.all([workspaceCommon(), readCommon(host)])
              .then(([left, right]) => left === right, () => false)
            if (!sameRepository) return { candidate, status: "error" as const }
            return { candidate, status: "ok" as const, owned: { submitted: candidate, directory, identity } }
          } catch (error) {
            isolate(error)
            return { candidate, status: "error" as const }
          }
        }))
        for (const entry of candidates) {
          if (entry.status === "ok") resolved.push(entry.owned)
          else {
            if (entry.status === "excluded") missing.push(entry.missing)
            result.directories.push({ directory: entry.candidate, status: entry.status })
          }
        }
      }
      if (!resolved.length && result.directories.some((entry) => entry.status !== "excluded")) return reply.code(403).send({ error: "Directory does not belong to workspace" })
      const assertCurrent = () => {
        signal.throwIfAborted()
        connection.assertCurrent()
        const currentRoot = manager.getServiceLocation(id)
        if (manager.get(id) !== workspace || currentRoot?.directory !== bootstrapDirectory || currentRoot.workspaceID !== undefined
          || deps.worktreeDeletionFence.isBlocked(rootIdentity)) {
          throw new Error("Pending request ownership changed")
        }
      }
      const assertOrigin = async (directory: string) => {
        // Resolve spelling/realpath aliases through existing ownership, but never accept a host alias as WSL-native provenance.
        if (!nativePath.isAbsolute(directory) || await manager.getServiceDirectoryForPath(id, directory) !== root
          || await manager.getServiceDirectoryForPath(id, workspace.path) !== root
          || await manager.getWorktreeIdentityForPath(id, bootstrapDirectory) !== rootIdentity) throw new Error("Invalid pending origin")
        assertCurrent()
      }
      const revalidateCandidates = async () => {
        const currentCommon = resolved.some((candidate) => candidate.directory !== root) || missing.some((entry) => entry.ancestor)
          ? await readCommon(workspace.path) : undefined
        for (let offset = 0; offset < resolved.length; offset += 8) {
          await drainOwnershipReads(resolved.slice(offset, offset + 8).map(async (candidate) => {
            if (failed.has(candidate.submitted)) return
            try {
              const host = candidate.directory === root ? undefined : await manager.getHostPathForServicePath(id, candidate.directory)
              const owned = !deps.worktreeDeletionFence.isBlocked(candidate.identity)
                && await manager.getServiceDirectoryForPath(id, candidate.submitted) === candidate.directory
                && (candidate.directory === root || (await manager.getWorktreeIdentityForPath(id, candidate.directory) === candidate.identity
                  && Boolean(host) && await readCommon(host!) === currentCommon))
              if (!owned) failed.add(candidate.submitted)
            } catch (error) {
              isolate(error)
              failed.add(candidate.submitted)
            }
          }))
        }
        // An exclusion stays valid only while its path is still absent and owned
        // by the same identity; a reappearing checkout becomes this directory's error.
        for (let offset = 0; offset < missing.length; offset += 8) {
          await drainOwnershipReads(missing.slice(offset, offset + 8).map(async ({ submitted, directory, identity, host, ancestor }) => {
            try {
              const owned = !deps.worktreeDeletionFence.isBlocked(identity)
                && await manager.getServiceDirectoryForPath(id, submitted) === directory
                && (!directory || await manager.getWorktreeIdentityForPath(id, directory) === identity)
                && await manager.getHostPathForServicePath(id, directory ?? submitted) === host
                && await missingHost(host)
                && (!ancestor || (await ownedMissingAncestor(submitted, async () => currentCommon!))?.identity === identity)
              if (!owned) failed.add(submitted)
            } catch (error) {
              isolate(error)
              failed.add(submitted)
            }
          }))
        }
        // A deletion that began during the awaits above still fences publication.
        for (const candidate of [...resolved, ...missing]) if (deps.worktreeDeletionFence.isBlocked(candidate.identity)) failed.add(candidate.submitted)
        assertCurrent()
      }
      assertCurrent()
      record("ownership")
      // Initial resolution above admits this read. Revalidate after all native
      // and placement IO, not repeatedly within the same pre/post-read phase.
      if (deferPendingDiscovery(connection, { loadedOnly: true })) return reply.header("Retry-After", "30").code(503).send({ error: PENDING_DISCOVERY_DEFERRED })
      // Even an all-excluded historical batch must negotiate real RPC capability.
      // The established root is the only bootstrap, never an inactive candidate.
      const expected = new Set(resolved.length ? resolved.map((entry) => entry.directory) : [root])
      const url = new URL("/api/rpc/codenomad.pending-requests/snapshot", connection.endpoint.url)
      url.searchParams.set("location[directory]", bootstrapDirectory)
      phase = "native-read"
      const response = await connection.fetch(url, { method: "POST", signal, redirect: "error",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { directories: [...expected] } }) })
      nativeStatus = response.status
      phase = "response-validation"
      assertCurrent()
      if (response.status === 400 && unavailableSchema.safeParse(await readBoundedJson(response)).success) {
        record("native")
        phase = "ownership-revalidation"
        await assertOrigin(bootstrapDirectory)
        await revalidateCandidates()
        record("revalidation")
        markLoadedPendingSupported(connection, false)
        return { supported: false } satisfies WorkspacePendingRequestsResponse
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error("Native pending requests unavailable") }
      const native = nativeSchema.parse(await readBoundedJson(response)).output
      record("native")
      if (native.data.length !== expected.size || new Set(native.data.map((entry) => entry.directory)).size !== expected.size
        || native.data.some((entry) => !expected.has(entry.directory))
        || native.data.reduce((count, entry) => count + entry.locations.length, 0) > 64) throw new Error("Invalid pending coverage")
      let placementRejected = false
      const readLocations = async (entry: (typeof native.data)[number]) => {
        const locations: WorkspacePendingRequestLocation[] = []
        if (new Set(entry.locations.map((snapshot) => snapshot.location.directory)).size !== entry.locations.length) throw new Error("Duplicate pending placement")
        if (entry.locations.reduce((count, snapshot) => count + snapshot.permissions.length, 0) > 1024
          || entry.locations.reduce((count, snapshot) => count + snapshot.forms.length, 0) > 1024) {
          throw new Error("Invalid pending request count")
        }
        for (const snapshot of entry.locations) {
          // A rejected placement withholds only its own directory's coverage and
          // capability verification; malformed native data above fails the batch.
          const owned = await (async () => snapshot.location.workspaceID === undefined && nativePath.isAbsolute(snapshot.location.directory)
            && await manager.getServiceDirectoryForPath(id, snapshot.location.directory) === entry.directory
            && await manager.ownsLocation(id, snapshot.location, connection.client, signal))().catch((error) => {
            isolate(error)
            return false
          })
          if (!owned) {
            placementRejected = true
            return undefined
          }
          locations.push({ location: { directory: snapshot.location.directory },
            permissions: snapshot.permissions as PermissionRequest[], forms: snapshot.forms as FormInfo[] })
        }
        if (!locations.length) locations.push({ location: { directory: entry.directory }, permissions: [], forms: [] })
        return locations
      }
      for (const entry of native.data) {
        const locations = await readLocations(entry)
        assertCurrent()
        for (const original of resolved.filter((candidate) => candidate.directory === entry.directory)) {
          if (locations) result.directories.push({ directory: original.submitted, status: "ok", locations })
          else failed.add(original.submitted)
        }
      }
      record("placement")
      phase = "ownership-revalidation"
      // Includes every admitted candidate, even empty/cold coverage. The root
      // identity is rechecked by assertOrigin; aliases still need their own check.
      await assertOrigin(native.originDirectory)
      await revalidateCandidates()
      record("revalidation")
      // Any admitted candidate (resolved or excluded) that failed revalidation also
      // withholds capability: a changed or fenced directory cannot verify the RPC.
      if (!placementRejected && !failed.size) markLoadedPendingSupported(connection, true)
      result.directories = [
        ...result.directories.filter((entry) => !failed.has(entry.directory)),
        ...[...failed].map((directory) => ({ directory, status: "error" as const })),
      ]
      return result
    } catch {
      record(phase)
      // Keep queue contents/paths and native payloads out of diagnostic logs.
      request.log.warn({ workspaceId: id, phase, nativeStatus, timedOut: signal.aborted, elapsedMs: Date.now() - started }, "Pending request recovery failed")
      // Never convert transport, malformed coverage or ownership errors to empty.
      return reply.code(503).send({ error: "Pending requests unavailable; retain existing queues" })
    }
  })
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Invalid pending response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return JSON.parse(Buffer.concat(chunks).toString("utf8"), (_key, value) => {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid pending JSON number")
        return value
      })
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error("Pending response exceeded bound")
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
