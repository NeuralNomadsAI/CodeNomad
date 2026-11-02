import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { Service } from "@opencode/client/service"
import { Context, Effect } from "effect"
import { missionSchedulePayloadDigest, missionScheduleRequestSchema } from "../../missions/mission-schedule-contract"
import { controlNativeMissionSchedule } from "./native-mission-schedule-control"
import { acquireNativeMissionScheduleAuthority, nativeMissionScheduleControlExecution } from "./native-mission-schedule-authority"
import { ownerFixture } from "./native-schedule-owner-test-fixture"

test("unplayed conversion to immediate is a document CAS without Schedule, provider availability or artifact files", async t => {
  const f = await ownerFixture(t), before = await f.read()
  const artifact = (name: string) => {
    const file = path.join(f.directory, name), sha256 = createHash("sha256").update(readFileSync(file)).digest("hex")
    rmSync(file)
    return { file, sha256 }
  }
  const artifacts = { provider: artifact("provider.mjs"), runtime: artifact("runtime.mjs") }
  const state = path.join(f.directory, "service-state"); mkdirSync(state)
  const url = "http://127.0.0.1:1"
  writeFileSync(path.join(state, "service-owned.json"), JSON.stringify({ id: "own", pid: process.pid, url }))
  t.mock.method(Service, "discover", async () => ({ url }))
  const configuration = { ...before.configuration, launch: { timing: { kind: "immediate" as const }, condition: null,
    ends: { maxLaunches: null, afterMs: null, at: null } } }
  const profileSource = { profileID: "profile", executionHost: "host", configYamlPath: path.join(f.directory, "profile.yaml") }
  const request = missionScheduleRequestSchema.parse({ missionID: before.id, requestID: "configure_immediate", action: "configure",
    expectedRevision: before.revision, configuration, transport: { sessionID: "human", workspaceID: "workspace", requestID: "configure_immediate",
      location: { directory: f.directory }, scheduleID: before.id, expectedRevision: before.revision, action: "configure", profileSource,
      configDigest: missionSchedulePayloadDigest({ configuration }), issuedAt: Date.now(), digest: "a".repeat(64), proof: "b".repeat(64) } })
  const authority: Effect.Success<ReturnType<typeof acquireNativeMissionScheduleAuthority>> = { request, before, store: f.store,
    location: f.ctx.location, ...nativeMissionScheduleControlExecution(request, f.current), profileSource }
  const apply = () => Effect.scoped(Effect.gen(function* () {
    const graph = yield* Effect.context<never>(), run = Effect.runPromiseWith(graph)
    return yield* controlNativeMissionSchedule(f.ctx, authority, artifacts, run)
  })).pipe(Effect.provideService(Context.Service<never, unknown>("@opencode/Global"), { state }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/server/ServerInfo"), { urls: () => [url] }))
  const response = await Effect.runPromise(apply())
  assert.equal(response.pending, false)
  const converted = await f.read()
  assert.equal(converted.configuration.launch.timing.kind, "immediate")
  assert.equal(converted.firstPlayedAt, null)
  assert.equal(converted.state, "paused")
  assert.deepEqual(converted.configuration.profiles, before.configuration.profiles)
  assert.deepEqual(converted.calendarOwner!.slots, [])
  assert.equal(converted.calendarOwner!.auxiliaryReady, false)
  assert.deepEqual(f.calls, [])
  assert.equal((await Effect.runPromise(apply())).document?.revision, converted.revision)
})
