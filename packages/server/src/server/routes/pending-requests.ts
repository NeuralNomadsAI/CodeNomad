import type { FastifyInstance } from "fastify"
import path from "node:path"
import { z } from "zod"
import type { FormInfo, PermissionRequest } from "@opencode/client"
import type { WorkspacePendingRequestLocation, WorkspacePendingRequestsResponse } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { readGitCommonDirectory } from "../../workspaces/git-common-directory"
import { deferPendingDiscovery, markLoadedPendingSupported, PENDING_DISCOVERY_DEFERRED } from "../../workspaces/pending-discovery"

const directorySchema = z.string().min(1).max(4096)
const querySchema = z.object({ directories: z.union([directorySchema, z.array(directorySchema).min(1).max(64)]) }).strict()
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

export interface PendingRequestsRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "getServiceLocation" | "getServicePathStyle" | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath" | "getHostPathForServicePath" | "ownsLocation">
  worktreeDeletionFence: Pick<WorktreeDeletionFence, "isBlocked">
}

export function registerPendingRequestRoutes(app: FastifyInstance, deps: PendingRequestsRouteDeps): void {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/pending-requests", async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const query = querySchema.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: "Invalid pending request directories" })
    const manager = deps.workspaceManager, id = request.params.id
    const workspace = manager.get(id)
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
    // Includes bounded Git ownership reads before/after the native reader's independent two-second deadline.
    const signal = AbortSignal.timeout(30_000)
    try {
      const connection = await manager.getSharedServiceConnection(id)
      if (!connection) return reply.code(503).send({ error: "Pending requests unavailable" })
      if (deferPendingDiscovery(connection, { loadedOnly: true })) return reply.header("Retry-After", "30").code(503).send({ error: PENDING_DISCOVERY_DEFERRED })
      const submitted = [...new Set(typeof query.data.directories === "string" ? [query.data.directories] : query.data.directories)]
      const result: Extract<WorkspacePendingRequestsResponse, { supported: true }> = { supported: true, directories: [] }
      const resolved: Array<{ submitted: string; directory: string; identity: string }> = []
      const provisional: typeof resolved = []
      const bootstrap = manager.getServiceLocation(id)
      const style = manager.getServicePathStyle(id)
      const nativePath = style === "win32" ? path.win32 : style === "posix" ? path.posix : undefined
      const root = await manager.getServiceDirectoryForPath(id, workspace.path)
      const rootIdentity = bootstrap && await manager.getWorktreeIdentityForPath(id, bootstrap.directory)
      if (!bootstrap || bootstrap.workspaceID !== undefined || !root || !rootIdentity || !nativePath?.isAbsolute(bootstrap.directory)
        || await manager.getServiceDirectoryForPath(id, bootstrap.directory) !== root) throw new Error("Pending bootstrap unavailable")
      const bootstrapDirectory = bootstrap.directory
      // ponytail: eight ownership checks at a time keep bounded Windows Git reads inside the request deadline.
      for (let offset = 0; offset < submitted.length; offset += 8) {
        const candidates = await drainOwnershipReads(submitted.slice(offset, offset + 8).map(async (candidate) => {
          signal.throwIfAborted()
          const directory = await manager.getServiceDirectoryForPath(id, candidate)
          const identity = directory && await manager.getWorktreeIdentityForPath(id, directory)
          const host = directory && await manager.getHostPathForServicePath(id, directory)
          if (!directory || !identity || !host) {
            result.directories.push({ directory: candidate, status: "error" })
            return
          }
          return { submitted: candidate, directory, identity }
        }))
        provisional.push(...candidates.filter((candidate) => candidate !== undefined))
      }
      if (!provisional.length) return reply.code(403).send({ error: "Directory does not belong to workspace" })
      const assertCurrent = () => {
        signal.throwIfAborted()
        connection.assertCurrent()
        const currentRoot = manager.getServiceLocation(id)
        if (manager.get(id) !== workspace || currentRoot?.directory !== bootstrapDirectory || currentRoot.workspaceID !== undefined
          || deps.worktreeDeletionFence.isBlocked(rootIdentity) || resolved.some(({ identity }) => deps.worktreeDeletionFence.isBlocked(identity))) {
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
      const assertCandidates = async (classify = false) => {
        const candidates = classify ? provisional : resolved
        const currentCommon = candidates.some((candidate) => candidate.directory !== root)
          ? await readGitCommonDirectory(workspace.path).catch(error => { if (!classify) throw error; return undefined }) : undefined
        for (let offset = 0; offset < candidates.length; offset += 8) {
          const checked = await drainOwnershipReads(candidates.slice(offset, offset + 8).map(async (candidate) => {
            signal.throwIfAborted()
            if (await manager.getServiceDirectoryForPath(id, candidate.submitted) !== candidate.directory
              || await manager.getWorktreeIdentityForPath(id, candidate.directory) !== candidate.identity) throw new Error("Pending directory ownership changed")
            if (candidate.directory !== root) {
              const host = await manager.getHostPathForServicePath(id, candidate.directory)
              if (!host) throw new Error("Pending directory ownership changed")
              // Containment alone cannot authorize a nested independent clone. Classify
              // once immediately before RPC; after RPC every accepted identity is fresh.
              const sameRepository = await readGitCommonDirectory(host).then(common => currentCommon !== undefined && common === currentCommon,
                error => { if (!classify) throw error; return false })
              if (!sameRepository) {
                if (!classify) throw new Error("Pending repository ownership changed")
                result.directories.push({ directory: candidate.submitted, status: "error" })
                return
              }
            }
            assertCurrent()
            return candidate
          }))
          if (classify) resolved.push(...checked.filter((candidate) => candidate !== undefined))
          assertCurrent()
        }
      }
      assertCurrent()
      await assertCandidates(true)
      if (!resolved.length) return reply.code(403).send({ error: "Directory does not belong to workspace" })
      await assertOrigin(bootstrapDirectory)
      if (deferPendingDiscovery(connection, { loadedOnly: true })) return reply.header("Retry-After", "30").code(503).send({ error: PENDING_DISCOVERY_DEFERRED })
      const expected = new Set(resolved.map((entry) => entry.directory))
      const url = new URL("/api/rpc/codenomad.pending-requests/snapshot", connection.endpoint.url)
      url.searchParams.set("location[directory]", bootstrapDirectory)
      const response = await connection.fetch(url, { method: "POST", signal, redirect: "error",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { directories: [...expected] } }) })
      assertCurrent()
      if (response.status === 400 && unavailableSchema.safeParse(await readBoundedJson(response)).success) {
        await assertOrigin(bootstrapDirectory)
        await assertCandidates()
        markLoadedPendingSupported(connection, false)
        return { supported: false } satisfies WorkspacePendingRequestsResponse
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error("Native pending requests unavailable") }
      const native = nativeSchema.parse(await readBoundedJson(response)).output
      await assertOrigin(native.originDirectory)
      if (native.data.length !== expected.size || new Set(native.data.map((entry) => entry.directory)).size !== expected.size
        || native.data.some((entry) => !expected.has(entry.directory))
        || native.data.reduce((count, entry) => count + entry.locations.length, 0) > 64) throw new Error("Invalid pending coverage")
      for (const entry of native.data) {
        const locations: WorkspacePendingRequestLocation[] = []
        if (new Set(entry.locations.map((snapshot) => snapshot.location.directory)).size !== entry.locations.length) throw new Error("Duplicate pending placement")
        if (entry.locations.reduce((count, snapshot) => count + snapshot.permissions.length, 0) > 1024
          || entry.locations.reduce((count, snapshot) => count + snapshot.forms.length, 0) > 1024) {
          throw new Error("Invalid pending request count")
        }
        for (const snapshot of entry.locations) {
          const owned = snapshot.location.workspaceID === undefined && nativePath.isAbsolute(snapshot.location.directory)
            && await manager.getServiceDirectoryForPath(id, snapshot.location.directory) === entry.directory
            && await manager.ownsLocation(id, snapshot.location, connection.client, signal)
          if (!owned) throw new Error("Invalid pending placement")
          locations.push({ location: { directory: snapshot.location.directory },
            permissions: snapshot.permissions as PermissionRequest[], forms: snapshot.forms as FormInfo[] })
        }
        // Even empty/cold coverage needs current directory ownership; no location.get.
        const stillOwned = await manager.getServiceDirectoryForPath(id, entry.directory) === entry.directory
        assertCurrent()
        if (!stillOwned) throw new Error("Pending directory ownership changed")
        if (!locations.length) {
          locations.push({ location: { directory: entry.directory }, permissions: [], forms: [] })
        }
        for (const original of resolved.filter((candidate) => candidate.directory === entry.directory)) {
          result.directories.push({ directory: original.submitted, status: "ok", locations })
        }
      }
      await assertOrigin(native.originDirectory)
      await assertCandidates()
      markLoadedPendingSupported(connection, true)
      return result
    } catch {
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
