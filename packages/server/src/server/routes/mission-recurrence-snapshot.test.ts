import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Schema } from "effect"
import { authorityDigest, authoritySignerDigest } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { RECURRENCE_AUTHORITY_POLICY } from "../../missions/recurrence-authority-contract"
import { NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { type RecurrenceConfig, RECURRENCE_STORAGE_PREFIX } from "../../missions/recurrence-contract"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { withNativeRecurrenceRpc } from "../../opencode/missions/managed-owner-plugin"
import { readNativeRecurrenceSnapshot } from "../../opencode/missions/native-recurrence-snapshot"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceSnapshot } from "./mission-recurrence-snapshot"

test("forged-parent restart stays unavailable through the owned RPC/route without native mutations", async () => {
  const directory = path.resolve("offline-recurrence-read")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory,
    project: { id: "project", directory, canonical: directory } })
  const config: RecurrenceConfig = { consigne: "Private instructions", clock: { time: "07:00", zone: "UTC" },
    profileID: "profile", executionHost: "host",
    profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
      roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
    taskMode: "native", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
    publication: { policy: "draft-only", conversationIDs: [] } }
  const namespace = "9f6f590e-271d-477f-8c02-7a6a119d63b9"
  const scope = { namespace, projectID: "project", projectCanonical: directory, scheduleID: "daily_review",
    profileID: "profile", executionHost: "host", daemonStorageID: "native_storage" }
  const source = new NativeMissionRecurrenceStore({ get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) }, "project", directory)
  const doc = { version: 1 as const, projectID: "project", projectCanonical: directory, id: scope.scheduleID,
    revision: 1, scheduleRevision: 0, createdAt: 100, state: "running" as const, config,
    lastDaily: null, settledCount: 0, cursors: [], pending: null, history: [] }
  const keys = generateKeyPairSync("ed25519")
  const body = { ...scope, version: 1 as const, policy: RECURRENCE_AUTHORITY_POLICY,
    authorityID: "authority", keyID: "key", roots: config.roots, scheduleRevision: 0, epoch: 1,
    expectedRevision: null, provisioningGeneration: "generation", signerDigest: authoritySignerDigest(keys.publicKey),
    action: "authorize" as const, configDigest: authorityDigest(config), config,
    budgets: { effects: 1, nativeCalls: 0, inboxMessages: 0, publications: 0 } }
  const parent = { body, signature: "A".repeat(86) + "==" } // Looks signed, but is not signed by the pinned key.
  const authority = new NativeRecurrenceAuthorityStore({ get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) }, scope)
  const values = new Map<string, unknown>([
    [`${RECURRENCE_STORAGE_PREFIX}/project/${source.projectToken}/${scope.scheduleID}`, doc],
    [`${RECURRENCE_STORAGE_PREFIX}/project/${source.projectToken}/foreign_worktree`, {
      ...doc, id: "foreign_worktree", state: "paused", config: { ...config,
        roots: [{ mode: "directory-only", directory: path.resolve("another-worktree") }] },
    }],
    [`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, namespace],
    [authority.key, { version: 1, scope, revision: 0, parent, settledSequence: 0, lastArchiveDigest: null, child: null }],
    [`${authority.parentKey}/parents/1`, parent],
  ])
  const writes: string[] = []
  let jobReads = 0, connected = true, owner = true, invalidate = false, workspace = { id: "workspace" }
  const storage = {
    get: (key: string) => Effect.sync(() => values.get(key)),
    scan: ({ prefix, after, limit }: { prefix: string; after?: string; limit: number }) => Effect.sync(() => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value }))
      return { entries }
    }),
    set: (key: string) => Effect.sync(() => { writes.push(key) }),
  }
  const dbTag = Context.Service<never, unknown>("@opencode/storage/Database")
  const locationTag = Context.Service<never, Location.Info>("@opencode/Location")
  const jobTag = Context.Service<never, unknown>("@opencode/Job")
  const db = { db: { $client: Object.assign(() => {}, { unsafe: () => ({ withoutTransform: Effect.succeed([]) }) }),
    transaction: () => Effect.die("Unexpected transaction") } }
  const job = { get: () => Effect.sync(() => { jobReads++; return { status: "running" } }),
    start: () => Effect.sync(() => { writes.push("job.start") }), cancel: () => Effect.sync(() => { writes.push("job.cancel") }) }
  const graph = Context.make(dbTag, db).pipe(Context.add(locationTag, location), Context.add(jobTag, job))
  const ctx = { storage, location } as unknown as Parameters<typeof readNativeRecurrenceSnapshot>[0]
  let rpcHandler!: () => ReturnType<typeof readNativeRecurrenceSnapshot>
  const rpc = Object.assign(() => ({}), { register: (_definition: unknown, handlers: { recurrenceSnapshot(): ReturnType<typeof readNativeRecurrenceSnapshot> }) =>
    Effect.sync(() => { rpcHandler = handlers.recurrenceSnapshot }) })
  const entry = withNativeRecurrenceRpc({ ...ctx, rpc } as never)
  await Effect.runPromiseWith(graph)(Effect.scoped(entry.register(CODENOMAD_MISSIONS_RPC, {} as never)))
  const read = () => Effect.runPromiseWith(graph)(rpcHandler())
  const snapshot = await read()
  assert.equal(snapshot.schedules.length, 1, "other worktree schedules are not exposed")
  assert.equal(snapshot.schedules[0].state, "unavailable")
  assert.equal(jobReads, 0, "a forged ledger must never grant a Job-status projection")
  // No Job survives a restart either. The read retains schedule data, not an invented interruption.

  const app = Fastify({ logger: false }), fence = new WorktreeDeletionFence()
  registerMissionRecurrenceSnapshot(app, { workspaceManager: {
    get: () => workspace, getServiceLocation: () => ({ directory }), ownsLocation: async () => owner,
    getSharedServiceConnection: async () => ({ client: {
      location: { get: async () => ({ project: { id: "project", canonical: directory } }) },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      rpc: () => ({ recurrenceSnapshot: async () => {
        const snapshot = await read()
        if (invalidate) await fence.run(directory, [directory], async () => {})
        return snapshot
      } }),
    }, assertCurrent: () => { if (!connected) throw new Error("Connection changed") } }),
  } as never, worktreeDeletionFence: fence })
  try {
    for (let n = 0; n < 2; n++) {
      const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace/missions/recurrence" })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().schedules[0], { id: scope.scheduleID, revision: 1, scheduleRevision: 0,
        state: "unavailable", clock: config.clock, pendingPassageID: null, settledCount: 0 })
      assert(!response.body.includes("Private instructions"))
      assert(!response.body.includes(parent.signature))
      assert(!response.body.includes(directory))
    }
    assert.deepEqual(writes, [], "read/refresh never writes storage or starts/rearms/cancels Job")
    assert.equal(jobReads, 0)
    owner = false
    assert.equal((await app.inject({ method: "GET", url: "/api/workspaces/workspace/missions/recurrence" })).statusCode, 403)
    owner = true; connected = false
    assert.equal((await app.inject({ method: "GET", url: "/api/workspaces/workspace/missions/recurrence" })).statusCode, 503)
    connected = true; invalidate = true
    assert.equal((await app.inject({ method: "GET", url: "/api/workspaces/workspace/missions/recurrence" })).statusCode, 503)
    workspace = { id: "workspace" }
  } finally { await app.close() }
  assert.deepEqual(writes, [])
})
