import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import path from "node:path"
import test from "node:test"
import { Context, Effect } from "effect"
import { nativeRecurrenceHandlers, recurrenceConfigDigest, recurrenceScheduleID } from "./native-recurrence-create"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "../../missions/lifecycle-input"
import { recurrenceConfigSchema } from "../../missions/recurrence-contract"
import { recurrenceInputBudget } from "../../missions/recurrence-read-budget"

test("direct native CREATE refuses effects 1, 2 and absent budgets before any KV access", async () => {
  const directory = path.resolve("isolated-direct-recurrence"), project = { id: "project", directory, canonical: directory }
  const location = { directory, project }
  const tag = Context.Service<never, unknown>("@opencode/Location")
  const graph = Context.make(tag, location)
  let reads = 0
  const storage = { get: () => { reads++; throw new Error("native KV must not be read") },
    scan: () => { reads++; throw new Error("native KV must not be scanned") } }
  const ctx = { location, storage } as unknown as Parameters<typeof nativeRecurrenceHandlers>[0]
  const selected = { agent: "agent", model: { providerID: "provider", id: "model" } }
  const scope = { channel: "stable", configIdentity: path.resolve("profile/config.yaml"),
    key: createHash("sha256").update(`stable\0${path.resolve("profile/config.yaml")}`).digest("hex") }
  const base = { template: "custom", consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: scope.key,
    executionHost: "local", profiles: { coordinator: selected, roles: { specialist: selected } }, taskMode: "native",
    roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
    publication: { policy: "disabled", conversationIDs: [] } }
  const requestID = "direct_low_budget", id = recurrenceScheduleID(project.id, project.canonical, requestID)
  for (const effects of [1, 2, undefined]) {
    const config = { ...base, ...(effects === undefined ? {} : { budgets: {
      effects, nativeCalls: 0, inboxMessages: 0, publications: 0,
    } }) }
    const operation = nativeRecurrenceHandlers(ctx).recurrenceCreate({ id, requestID, config,
      digest: recurrenceConfigDigest(config), directory, scope, executionHost: "local" })
    await assert.rejects(Effect.runPromise(Effect.provide(operation, graph)),
      effects === undefined ? /Recurrence creation scope differs/ : /Recurrence needs three fixed effects/)
    assert.equal(reads, 0, "the deterministic key remains unoccupied")
  }
  const oversized = { ...base, consigne: "x".repeat(MISSION_LIFECYCLE_TEXT_LIMIT + 1),
    budgets: { effects: 3, nativeCalls: 0, inboxMessages: 0, publications: 0 } }
  await assert.rejects(Effect.runPromise(Effect.provide(nativeRecurrenceHandlers(ctx).recurrenceCreate({ id, requestID,
    config: oversized, digest: recurrenceConfigDigest(oversized), directory, scope, executionHost: "local" }), graph)))
  assert.equal(reads, 0, "oversized direct native CREATE must not touch KV")
  const followed = { ...base, watchedConversationIDs: ["ses_watched"], budgets: { effects: 4, nativeCalls: 0, inboxMessages: 1, publications: 0 } }
  const limit = recurrenceInputBudget(followed).instructionsMaximum
  assert.equal(recurrenceConfigSchema.parse({ ...followed, consigne: "x".repeat(limit) }).consigne.length, limit)
  for (const config of [{ ...followed, budgets: { ...followed.budgets, effects: 3 } },
    { ...followed, budgets: { ...followed.budgets, inboxMessages: 0 } }, { ...followed, consigne: "x".repeat(limit + 1) }]) {
    await assert.rejects(Effect.runPromise(Effect.provide(nativeRecurrenceHandlers(ctx).recurrenceCreate({ id, requestID,
      config, digest: recurrenceConfigDigest(config), directory, scope, executionHost: "local" }), graph)))
    assert.equal(reads, 0, "source budgets and whole-input overflow fail before any native KV access")
  }
})
