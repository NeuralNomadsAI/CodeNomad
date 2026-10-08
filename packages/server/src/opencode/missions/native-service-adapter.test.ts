import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { acquireMissionNativeService } from "./native-service-adapter"
import type { AutonomousMissionCommand } from "./autonomous-contract"

const sessionTag = Context.Service<never, unknown>("@opencode/Session")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const directory = path.resolve("native-service-adapter-unit-only")
const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
const command: AutonomousMissionCommand = { kind: "prompt", input: { sessionID: "ses_owned", id: "msg_owned",
  text: "Owned work", metadata: { "codenomad.mission": { version: 1, missionID: "msn_owned", kind: "assignment", taskKey: "work" } },
  delivery: "queue", resume: true } }
const info = Schema.decodeUnknownSync(Session.Info)({ id: "ses_owned", projectID: "project", location: { directory },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })
const receipt = (value: AutonomousMissionCommand, type = value.kind === "prompt" ? "user" : "synthetic") =>
  Schema.decodeUnknownSync(SessionInbox.Info)({ id: value.input.id, sessionID: value.input.sessionID, type,
    payload: { text: value.input.text, metadata: value.input.metadata }, delivery: value.input.delivery, time: { created: 1 } })

test("real-shaped native service invokes entry fences, replaces environment, and retires with its Effect scope", async () => {
  const effects: string[] = []
  const service = { get: () => Effect.succeed({ ...info, location: { ...info.location, workspaceID: undefined } }),
    create: () => Effect.die("Unexpected create"), inbox: () => Effect.succeed([]),
    environment: (input: { variables: Record<string, string> }) => Effect.sync(() => { effects.push("environment"); return { ...input.variables } }),
    prompt: () => Effect.sync(() => { effects.push("prompt"); return receipt(command) }),
    synthetic: () => Effect.succeed(receipt({ ...command, kind: "synthetic" })),
  }
  const scope = await Effect.runPromise(Scope.make())
  const native = await Effect.runPromise(acquireMissionNativeService().pipe(
    Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location), Effect.provideService(Scope.Scope, scope)))
  assert.equal((await native.get({ sessionID: "ses_owned" })).id, "ses_owned")
  assert.deepEqual((await native.get({ sessionID: "ses_owned" })).location, { directory })
  let allowed = false
  const current = () => { assert(allowed, "revoked"); effects.push("fence"); return true as const }
  await assert.rejects(native.environment({ sessionID: "ses_owned", variables: { MARKER: "fresh" } }, {}, current), /policy-unqualified/)
  await assert.rejects(native.admit(command, {}, current), /policy-unqualified/)
  assert.deepEqual(effects, [])
  allowed = true
  await native.environment({ sessionID: "ses_owned", variables: { MARKER: "fresh" } }, {}, current)
  assert.equal((await native.admit(command, {}, current)).id, "msg_owned")
  assert.deepEqual(effects, ["fence", "environment", "fence", "prompt"])
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await assert.rejects(native.admit(command, {}, current), /authorization-blocked/)
})

test("missing/private contract changes fail closed without HTTP fallback or version checks", async () => {
  await assert.rejects(Effect.runPromise(Effect.scoped(acquireMissionNativeService())), /unavailable/)
  const service = { get: () => Effect.succeed(info), create: () => Effect.die("Unexpected create"), inbox: () => Effect.succeed([]),
    environment: () => Effect.succeed(undefined), prompt: () => ({ invented: true }), synthetic: () => Effect.succeed(receipt(command)) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      await assert.rejects(native.environment({ sessionID: "ses_owned", variables: {} }, {}, () => true))
      await assert.rejects(native.admit(command, {}, () => true))
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})

test("authority call-entry rejects false, void, promises and thenables before environment or admission", async () => {
  let effects = 0, assimilated = 0
  const service = { get: () => Effect.succeed(info), create: () => Effect.die("Unexpected create"), inbox: () => Effect.succeed([]),
    environment: () => Effect.sync(() => { effects++; return {} }),
    prompt: () => Effect.sync(() => { effects++; return receipt(command) }),
    synthetic: () => Effect.sync(() => { effects++; return receipt({ ...command, kind: "synthetic" }) }) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      const invalid = [() => false, () => undefined, () => Promise.resolve(true), () => Promise.reject(new Error("owner retired")),
        () => ({ then() { assimilated++; throw new Error("must not assimilate") } })]
      for (const guard of invalid) {
        // Deliberately violate the static contract to test untyped runtime callers.
        const unsafe = guard as unknown as () => true
        await assert.rejects(native.environment({ sessionID: "ses_owned", variables: {} }, {}, unsafe), /policy-unqualified/)
        for (const kind of ["prompt", "synthetic"] as const) {
          await assert.rejects(native.admit({ ...command, kind }, {}, unsafe), /policy-unqualified/)
        }
      }
      // Untyped callers can omit required arguments; there is no default approval.
      await assert.rejects(Reflect.apply(native.environment, undefined, [{ sessionID: "ses_owned", variables: {} }, {}]), /policy-unqualified/)
      for (const kind of ["prompt", "synthetic"] as const) {
        await assert.rejects(Reflect.apply(native.admit, undefined, [{ ...command, kind }, {}]), /policy-unqualified/)
      }
      assert.equal((await native.get({ sessionID: "ses_owned" })).id, "ses_owned")
      assert.deepEqual(await native.inbox("ses_owned"), [])
      assert.equal(effects, 0)
      assert.equal(assimilated, 0)
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})

test("native root creation checks the exact requested location, profile and mission metadata at one call entry", async () => {
  const input = { id: "ses_root", title: "Mission coordinator", location: { directory },
    agent: "worker", model: { providerID: "provider", id: "model", variant: "fast" },
    metadata: { "codenomad.mission": { version: 1, missionID: "msn_owned", kind: "coordinator", role: "coordinator" } } }
  const root = Schema.decodeUnknownSync(Session.Info)({ ...info, ...input, location: { directory },
    time: { created: 1, updated: 1 } })
  let entered = 0, claimed = false, changed = false
  const service = { get: () => Effect.succeed(root), inbox: () => Effect.succeed([]),
    environment: () => Effect.succeed({}), prompt: () => Effect.succeed(receipt(command)),
    synthetic: () => Effect.succeed(receipt({ ...command, kind: "synthetic" })),
    create: () => Effect.sync(() => { entered++; return changed ? { ...root, metadata: {} } : root }) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      const current = () => { assert(claimed); return true as const }
      await assert.rejects(native.create(input, {}, current), /policy-unqualified/)
      assert.equal(entered, 0)
      claimed = true
      assert.equal((await native.create(input, {}, current)).id, input.id)
      changed = true
      await assert.rejects(native.create(input, {}, current), /effect-unavailable/)
      assert.equal(entered, 2)
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})

test("relocation or profile change during preparation blocks ENV and synthetic at native call entry", async () => {
  const metadata = { "codenomad.mission": { version: 1, missionID: "msn_owned", kind: "coordinator", role: "coordinator" } }
  const expected = { id: "ses_owned", projectID: "project", location: { directory }, agent: "worker",
    model: { providerID: "provider", id: "model" }, metadata }
  let moved = false, changedModel = false, mutations = 0, fences = 0
  const service = { get: () => Effect.sync(() => Schema.decodeUnknownSync(Session.Info)({ ...info,
    agent: expected.agent, model: changedModel ? { providerID: "provider", id: "other" } : expected.model,
    metadata, location: { directory: moved ? `${directory}-moved` : directory }, time: { created: 1, updated: 1 } })),
    create: () => Effect.die("Unexpected create"), inbox: () => Effect.succeed([]),
    environment: (input: { variables: Record<string, string> }) => Effect.sync(() => { mutations++; return input.variables }),
    prompt: () => Effect.sync(() => { mutations++; return receipt(command) }),
    synthetic: () => Effect.sync(() => { mutations++; return receipt({ ...command, kind: "synthetic" }) }) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      assert.equal((await native.get({ sessionID: expected.id })).location.directory, directory)
      await Promise.resolve() // Native Session may move while ENV/profile is prepared.
      moved = true
      const current = () => { fences++; return true as const }
      await assert.rejects(native.environment({ sessionID: expected.id, variables: { MARKER: "fresh" } }, {}, current, expected), /binding-mismatch/)
      await assert.rejects(native.admit({ ...command, kind: "synthetic" }, {}, current, expected), /binding-mismatch/)
      moved = false; changedModel = true
      await assert.rejects(native.environment({ sessionID: expected.id, variables: {} }, {}, current, expected), /binding-mismatch/)
      await assert.rejects(native.admit({ ...command, kind: "synthetic" }, {}, current, expected), /binding-mismatch/)
      assert.equal(mutations, 0)
      assert.equal(fences, 0, "the one-use native admission fence is not spent on a moved target")
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})
