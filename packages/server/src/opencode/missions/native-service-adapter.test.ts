import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { acquireMissionNativeService } from "./native-service-adapter"
import type { AutonomousMissionCommand } from "./autonomous-contract"
import { recurrenceInputBudget } from "../../missions/recurrence-read-budget"

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

test("passage handles outlive one wake Scope only while the borrowed Location remains current", async () => {
  let current = true, effects = 0
  const service = { get: () => Effect.succeed(info), create: () => Effect.die("Unexpected create"), inbox: () => Effect.succeed([]),
    environment: (input: { variables: Record<string, string> }) => Effect.sync(() => { effects++; return input.variables }),
    prompt: () => Effect.succeed(receipt(command)), synthetic: () => Effect.succeed(receipt({ ...command, kind: "synthetic" })) }
  const native = await Effect.runPromise(Effect.scoped(acquireMissionNativeService(() => {
    if (!current) throw new Error("Location evicted")
    return true
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
  await native.environment({ sessionID: info.id, variables: {} }, {}, () => true)
  assert.equal(effects, 1)
  current = false
  await assert.rejects(native.environment({ sessionID: info.id, variables: {} }, {}, () => true), /Location evicted/)
  assert.equal(effects, 1)
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

test("Pause after lazy Effect construction but before evaluation admits no create, ENV, prompt or synthetic", async () => {
  const metadata = { "codenomad.mission": { version: 1, missionID: "msn_owned", kind: "coordinator", role: "coordinator" } }
  const expected = { id: "ses_owned", projectID: "project", location: { directory }, agent: "worker",
    model: { providerID: "provider", id: "model" }, metadata }
  const root = Schema.decodeUnknownSync(Session.Info)({ id: expected.id, projectID: expected.projectID,
    location: expected.location, agent: expected.agent, model: expected.model, metadata,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 } })
  let paused = false, constructed = 0, effects = 0
  const lazy = (result: unknown) => { constructed++; paused = true; return Effect.sync(() => { effects++; return result }) }
  const service = { get: () => Effect.succeed(root), inbox: () => Effect.succeed([]),
    create: () => lazy(root), environment: (input: { variables: Record<string, string> }) => lazy(input.variables),
    prompt: () => lazy(receipt(command)), synthetic: () => lazy(receipt({ ...command, kind: "synthetic" })) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      const current = () => { assert.equal(paused, false, "Pause must fence the lazy native Effect"); return true as const }
      const create = { id: expected.id, title: "Mission coordinator", location: { directory },
        agent: expected.agent, model: expected.model, metadata }
      for (const action of [
        () => native.create(create, {}, current),
        () => native.environment({ sessionID: expected.id, variables: { MARKER: "fresh" } }, {}, current, expected),
        () => native.admit(command, {}, current, expected),
        () => native.admit({ ...command, kind: "synthetic" }, {}, current, expected),
      ]) {
        paused = false
        await assert.rejects(action(), /policy-unqualified/)
      }
      assert.equal(constructed, 4)
      assert.equal(effects, 0)
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})

test("omitted native variant accepts materialized default but never a high variant at root ENV/message entry", async () => {
  const metadata = { "codenomad.mission": { version: 1, missionID: "msn_owned", kind: "coordinator", role: "coordinator" } }
  const request = { id: "ses_owned", title: "Mission coordinator", location: { directory },
    agent: "worker", model: { providerID: "provider", id: "model" }, metadata }
  const expected = { ...request, projectID: "project" }
  let variant = "default", writes = 0
  const session = () => Schema.decodeUnknownSync(Session.Info)({ ...expected,
    model: { ...request.model, variant }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 } })
  const service = { get: () => Effect.sync(session), create: () => Effect.sync(() => { writes++; return session() }),
    inbox: () => Effect.succeed([]), environment: (input: { variables: Record<string, string> }) => Effect.sync(() => {
      writes++; return input.variables
    }), prompt: () => Effect.sync(() => { writes++; return receipt(command) }),
    synthetic: () => Effect.sync(() => { writes++; return receipt({ ...command, kind: "synthetic" }) }) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      const current = () => true as const
      assert.equal((await native.create(request, {}, current)).model?.variant, "default")
      await native.environment({ sessionID: request.id, variables: { MARKER: "fresh" } }, {}, current, expected)
      await native.admit({ ...command, kind: "synthetic" }, {}, current, expected)
      assert.equal(writes, 3)
      variant = "high"
      await assert.rejects(native.environment({ sessionID: request.id, variables: {} }, {}, current, expected), /binding-mismatch/)
      await assert.rejects(native.admit({ ...command, kind: "synthetic" }, {}, current, expected), /binding-mismatch/)
      await assert.rejects(native.create(request, {}, current), /effect-unavailable/)
      assert.equal(writes, 4, "wrong create ACK is unknown, not a successful matching profile")
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})

test("actual native source method reads only bounded new messages, pins placement/cursor and excludes images and provider secrets", async () => {
  let moved = false, missing = false, entered = 0, acknowledged = true, oversized = false, revoked = false, revokeOnPrepare = false
  const calls: unknown[] = []
  const output = [
    Schema.decodeUnknownSync(SessionMessage.Info)({ id: "msg_first", type: "user", text: "First reply",
      files: [{ data: "SU1BR0VfQllURVM=", source: { type: "inline" }, mime: "image/png", name: "image" }], time: { created: 1 } }),
    Schema.decodeUnknownSync(SessionMessage.Info)({ id: "msg_second", type: "assistant", agent: "build",
      model: { providerID: "provider", id: "model" }, providerState: { credential: "CREDENTIAL_BYTES" },
      content: [{ type: "text", text: "Native answer" }], time: { created: 2, completed: 3 } }),
  ]
  const service = { get: () => Effect.succeed({ ...info, location: { directory: moved ? `${directory}-moved` : directory } }),
    create: () => Effect.die("Unexpected create"), inbox: () => Effect.succeed([]), environment: () => Effect.succeed({}),
    prompt: () => Effect.succeed(receipt(command)), synthetic: () => Effect.succeed(receipt({ ...command, kind: "synthetic" })),
    message: (input: { messageID: string }) => Effect.succeed(missing ? undefined
      : oversized && input.messageID === output[0].id ? { ...output[0], text: "x".repeat(20_000) } : output.find(item => item.id === input.messageID)),
    messages: (input: { limit: number; cursor?: { id: string }; order: string }) => {
      if (revokeOnPrepare) revoked = true
      return Effect.sync(() => {
      entered++; calls.push(input)
      if (!acknowledged) throw Error("Unknown native read ACK")
      if (oversized) return [{ ...output[0], text: "x".repeat(20_000) }]
      return output.slice(input.cursor ? output.findIndex(item => item.id === input.cursor!.id) + 1 : 0).slice(0, input.limit)
      })
    },
  }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      let fences = 0
      const request = { sessionID: "ses_owned", directory, afterMessageID: null, limit: 2, contextLimit: 16_384 }
      const fence = () => { fences++; return true as const }
      const first = await native.sourceMessages(request, {}, fence, () => true)
      assert.deepEqual(first.map(({ id, type, text }) => ({ id, type, text })),
        [{ id: "msg_first", type: "user", text: "First reply" }, { id: "msg_second", type: "assistant", text: "Native answer" }])
      assert(first.every(item => /^[a-f0-9]{64}$/.test(item.nativeDigest)))
      assert.equal(first[1].completedAt, 3)
      assert(!JSON.stringify(first).includes("BYTES"))
      assert.equal(fences, 1)
      const second = await native.sourceMessages({ ...request, afterMessageID: "msg_first" }, {}, fence, () => true)
      assert.deepEqual(second, [first[1]])
      assert.deepEqual(calls[1], { sessionID: "ses_owned", order: "asc", limit: 2, cursor: { id: "msg_first", direction: "next" } })
      missing = true
      await assert.rejects(native.sourceMessages({ ...request, afterMessageID: "msg_first" }, {}, fence, () => true), /observation-unavailable/)
      missing = false; moved = true
      await assert.rejects(native.sourceMessages(request, {}, fence, () => true), /binding-mismatch/)
      moved = false
      await assert.rejects(native.sourceMessages({ ...request, limit: 33 }, {}, fence, () => true), /effect-unavailable/)
      assert.equal(entered, 2)
      revokeOnPrepare = true
      const placement = () => { assert.equal(revoked, false, "source admission revoked"); return true as const }
      await assert.rejects(native.sourceMessages(request, {}, fence, placement), /policy-unqualified/)
      assert.equal(entered, 2, "revocation after constructing a lazy messages Effect blocks native entry")
      revokeOnPrepare = false; revoked = false; oversized = true
      const blocked = await native.sourceMessages(request, {}, fence, placement)
      assert.equal(blocked[0].id, "msg_first")
      assert.equal(blocked[0].text, "")
      assert.equal(blocked[0].needsDecision, "source-input-capacity", "overlarge text is referenced, never trimmed and marked processed")
      oversized = false
      acknowledged = false
      await assert.rejects(native.sourceMessages(request, {}, fence, () => true), /Unknown native read ACK/)
      assert.equal(entered, 4)
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})

test("a reverted or changed source anchor after the async messages query cannot acknowledge an empty page", async () => {
  const original = Schema.decodeUnknownSync(SessionMessage.User)({ id: "msg_anchor", type: "user", text: "Original source bytes", time: { created: 1 } })
  let anchor: typeof original | undefined = original, moved = false, foreign = false
  let race: "none" | "delete" | "rewrite" | "move" | "project" = "none", reads = 0, anchorReads = 0
  const service = { get: () => Effect.succeed({ ...info, projectID: foreign ? "foreign" : info.projectID,
      location: { directory: moved ? `${directory}-moved` : directory } }),
    create: () => Effect.die("unexpected create"), inbox: () => Effect.succeed([]), environment: () => Effect.succeed({}),
    prompt: () => Effect.succeed(receipt(command)), synthetic: () => Effect.succeed(receipt({ ...command, kind: "synthetic" })),
    message: (input: { messageID: string; sessionID: string }) => Effect.sync(() => {
      assert.deepEqual(input, { sessionID: "ses_owned", messageID: "msg_anchor" }); anchorReads++; return anchor
    }),
    messages: () => Effect.promise(async () => {
      reads++; await Promise.resolve()
      if (race === "delete") anchor = undefined
      if (race === "rewrite") anchor = { ...original, text: "Rewritten source bytes" }
      if (race === "move") moved = true
      if (race === "project") foreign = true
      return [] // Native missing-anchor behavior, not a positive no-change proof.
    }) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      const request = { sessionID: "ses_owned", directory, afterMessageID: "msg_anchor", limit: 2, contextLimit: 16_384 }
      assert.deepEqual(await native.sourceMessages(request, {}, () => true, () => true), [])
      assert.equal(anchorReads, 2, "same original anchor is checked both sides of the query")
      for (const changed of ["delete", "rewrite", "move", "project"] as const) {
        race = changed; anchor = original; moved = false; foreign = false
        await assert.rejects(native.sourceMessages(request, {}, () => true, () => true),
          changed === "delete" || changed === "rewrite" ? /observation-unavailable/ : /binding-mismatch/)
      }
      assert.equal(reads, 5, "no automatic query retry or replacement anchor")
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})

test("native completion and unchanged point-read bytes are required; no later IDs pass a streaming or updated reply", async () => {
  const assistant = (completed: boolean, text = "Stable complete reply") => Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: "msg_reply", type: "assistant", agent: "build", model: { providerID: "fixture", id: "model" },
    content: [{ type: "text", text }], time: { created: 1, ...(completed ? { completed: 3 } : {}) } })
  const later = Schema.decodeUnknownSync(SessionMessage.User)({ id: "msg_later", type: "user", text: "Later reply", time: { created: 4 } })
  let completed = false, changing = false, pointReads = 0
  const service = { get: () => Effect.succeed(info), create: () => Effect.die("unexpected create"), inbox: () => Effect.succeed([]),
    environment: () => Effect.succeed({}), prompt: () => Effect.succeed(receipt(command)), synthetic: () => Effect.succeed(receipt({ ...command, kind: "synthetic" })),
    messages: () => Effect.succeed([assistant(completed), later]),
    message: (input: { messageID: string }) => Effect.sync(() => {
      pointReads++; return input.messageID === "msg_reply" ? assistant(completed, changing ? "Changed after query" : "Stable complete reply") : later
    }) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      const request = { sessionID: "ses_owned", directory, afterMessageID: null, limit: 2, contextLimit: 16_384 }
      assert.deepEqual(await native.sourceMessages(request, {}, () => true, () => true), [])
      assert.equal(pointReads, 0, "a known streaming message is deferred without unrelated native activity reads")
      completed = true; changing = true
      assert.deepEqual(await native.sourceMessages(request, {}, () => true, () => true), [])
      assert.equal(pointReads, 1, "changed completion bytes defer this ID and later IDs")
      changing = false
      const stable = await native.sourceMessages(request, {}, () => true, () => true)
      assert.deepEqual(stable.map(item => item.id), ["msg_reply", "msg_later"])
      assert.equal(stable[0].completedAt, 3)
      assert(stable.every(item => /^[a-f0-9]{64}$/.test(item.nativeDigest)))
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})

test("remaining deterministic coordinator room includes whole 2–8 KiB stable replies and references a genuinely oversized reply", async () => {
  let text = "", queryCount = 0
  const reply = () => Schema.decodeUnknownSync(SessionMessage.Assistant)({ id: "msg_full_reply", type: "assistant", agent: "build",
    model: { providerID: "fixture", id: "model" }, content: [{ type: "text", text }], time: { created: 1, completed: 3 } })
  const service = { get: () => Effect.succeed(info), create: () => Effect.die("unexpected create"), inbox: () => Effect.succeed([]),
    environment: () => Effect.succeed({}), prompt: () => Effect.succeed(receipt(command)), synthetic: () => Effect.succeed(receipt({ ...command, kind: "synthetic" })),
    messages: () => Effect.sync(() => { queryCount++; return [reply()] }), message: () => Effect.sync(reply) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const native = yield* acquireMissionNativeService()
    yield* Effect.promise(async () => {
      const budget = recurrenceInputBudget({ consigne: "Review new replies", roots: [{ directory }], watchedConversationIDs: ["ses_owned"] })
      const request = { sessionID: "ses_owned", directory, afterMessageID: null, limit: 2, contextLimit: budget.sourceContextLimit }
      for (const length of [2 * 1024, 4 * 1024, 8 * 1024]) {
        text = "x".repeat(length)
        const read = await native.sourceMessages(request, {}, () => true, () => true)
        assert.equal(read[0].text, text, "normal reply is neither shortened nor replaced with a summary")
        assert.equal(read[0].needsDecision, undefined)
        assert.equal(read[0].completedAt, 3)
      }
      text = "x".repeat(20 * 1024)
      const blocked = await native.sourceMessages(request, {}, () => true, () => true)
      assert.equal(blocked[0].id, "msg_full_reply")
      assert.equal(blocked[0].needsDecision, "source-input-capacity")
      assert.equal(blocked[0].text, "")
      assert.match(blocked[0].nativeDigest, /^[a-f0-9]{64}$/)
      assert.equal(queryCount, 4, "no alternate reader, retry or workflow engine")
    })
  })).pipe(Effect.provideService(sessionTag, service), Effect.provideService(locationTag, location)))
})
