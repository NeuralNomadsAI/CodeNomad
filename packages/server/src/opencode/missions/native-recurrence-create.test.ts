import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { Context, Effect } from "effect"
import { nativeRecurrenceHandlers, recurrenceConfigDigest, recurrenceScheduleID } from "./native-recurrence-create"
import { recurrenceConfigSchema } from "../../missions/recurrence-contract"

test("native CREATE rejects direct model/RPC calls without authenticated transport before KV access", async () => {
  const directory = path.resolve("direct-recurrence-memory"), project = { id: "project", directory, canonical: directory }
  const location = { directory, project }, graph = Context.make(Context.Service<never, unknown>("@opencode/Location"), location)
  let reads = 0
  const storage = { get: () => { reads++; throw new Error("No KV access") }, scan: () => { reads++; throw new Error("No scan") } }
  const ctx = { location, storage } as unknown as Parameters<typeof nativeRecurrenceHandlers>[0]
  const selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
  const config = { title: "Review", template: "custom", consigne: "Review", taskMode: "native", clock: { time: "07:00", zone: "UTC" },
    profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
    profiles: { coordinator: selection, roles: { specialist: selection } } }
  recurrenceConfigSchema.parse(config)
  assert.equal(recurrenceConfigSchema.safeParse({ ...config, budgets: { effects: 3 } }).success, false)
  assert.equal(recurrenceConfigSchema.safeParse({ ...config, publication: {} }).success, false)
  const requestID = "request_one", id = recurrenceScheduleID(project.id, project.canonical, requestID)
  const input = { id, requestID, config, digest: recurrenceConfigDigest(config), directory, scope: {}, executionHost: "local" }
  await assert.rejects(Effect.runPromise(nativeRecurrenceHandlers(ctx).recurrenceCreate(input).pipe(Effect.provide(graph))))
  const identity = { sessionID: "auth-disabled", workspaceID: "workspace", scheduleID: id, requestID,
    expectedRevision: 0, action: "create", configDigest: input.digest, location: { directory }, issuedAt: Date.now(),
    digest: "0".repeat(64), proof: "0".repeat(64), profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/config.yaml" } }
  await assert.rejects(Effect.runPromise(nativeRecurrenceHandlers(ctx).recurrenceCreate({ ...input, transport: identity }).pipe(Effect.provide(graph))))
  assert.equal(reads, 0)
})
