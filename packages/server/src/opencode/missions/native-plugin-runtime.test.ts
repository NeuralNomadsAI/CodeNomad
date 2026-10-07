import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { Plugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { Context, Effect, Exit, Logger, MutableHashMap, Option, RcMap, References, Schema, Scope } from "effect"
import { acquireMissionNativeService } from "./native-service-adapter"

const sessionTag = Context.Service<never, unknown>("@opencode/Session")
const locationTag = Context.Service<never, Location.Info>("@opencode/Location")

// Conditional graph-supplied composition check, NOT native setup qualification.
// Core Plugin.load seals external setup to Scope/logging services; only internal
// plugins receive its explicit graph wrapper. An HTTP RPC proof is not a setup
// proof. Do not ship this composition until its graph producer is qualified.
function fixture(name: string) {
  const directory = path.resolve(`native-plugin-runtime-unit-${name}`)
  const location = Schema.decodeUnknownSync(Location.Info)({ directory,
    project: { id: name, directory, canonical: directory } })
  const info = Schema.decodeUnknownSync(Session.Info)({ id: `ses_${name}`, projectID: name,
    location: { directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 } })
  let setupCount = 0, cleanupCount = 0, calls = 0, finalizations = 0
  let late: (signal?: AbortSignal) => Promise<string>
  let readStorage: () => Promise<Schema.Json | undefined>
  let startWaiting: () => Promise<unknown>
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const service = {
    get: () => Effect.gen(function* () {
      assert.equal(yield* sessionTag, service)
      assert.equal(yield* locationTag, location)
      calls++
      return info
    }),
    environment: () => Effect.succeed({}),
    prompt: () => Effect.die("Unexpected admission"),
    synthetic: () => Effect.die("Unexpected admission"),
    inbox: () => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { finalizations++ }))
      entered()
      return yield* Effect.never
    }).pipe(Effect.scoped),
  }
  // Construct the real installed Promise adapter; unrelated domains fail if
  // invoked. Native services are provided only through their actual graph tags.
  const unused: any = new Proxy(() => { throw new Error("Unexpected native API") }, { get: () => unused })
  const storage = { get: () => Effect.gen(function* () {
    assert.equal(yield* sessionTag, service)
    return (yield* locationTag).project.id
  }) }
  const host = new Proxy({ app: { version: "2.0.24" }, location, options: {}, storage }, {
    get: (target, key) => Reflect.get(target, key) ?? unused,
  }) as unknown as Plugin.Context
  const entry = Plugin.define({
    id: "private.missions.runtime-qualification",
    effect: ctx => Effect.gen(function* () {
      const native = yield* acquireMissionNativeService()
      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      yield* fromPromise({ id: "private.missions.runtime-qualification", setup: async promiseCtx => {
        setupCount++
        assert.equal(promiseCtx.location, ctx.location)
        readStorage = () => promiseCtx.storage.get("fixture")
        late = async signal => (await native.get({ sessionID: info.id }, {
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        })).projectID
        startWaiting = () => native.inbox(info.id, { signal: controller.signal })
        return async () => {
          // Retire callbacks BEFORE asynchronous cleanup, not after it returns.
          controller.abort()
          cleanupCount++
          await assert.rejects(late())
        }
      } }).effect(ctx)
    }).pipe(Effect.orDie),
  })
  return { entry, host, service, location, waiting,
    late: (signal?: AbortSignal) => late(signal), readStorage: () => readStorage(),
    startWaiting: () => startWaiting(),
    counts: () => ({ setupCount, cleanupCount, calls, finalizations }) }
}

test("graph-supplied installed Effect/Promise composition retains one Location and fences cleanup/late callbacks", async t => {
  const a = fixture("a"), b = fixture("b")
  const open = async (f: ReturnType<typeof fixture>) => {
    const scope = await Effect.runPromise(Scope.make())
    const close = () => Effect.runPromise(Scope.close(scope, Exit.void))
    t.after(close)
    const graph = Context.make(sessionTag, f.service).pipe(Context.add(locationTag, f.location), Context.add(Scope.Scope, scope))
    await Effect.runPromiseWith(graph)(f.entry.effect(f.host))
    return close
  }
  const closeA = await open(a), closeB = await open(b)
  assert.deepEqual(await Promise.all([a.late(), b.late(), a.readStorage(), b.readStorage()]), ["a", "b", "a", "b"])
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(a.late(cancelled.signal))
  const pending = a.startWaiting()
  const rejected = assert.rejects(pending)
  await a.waiting
  await closeA()
  await rejected
  await assert.rejects(a.late())
  assert.equal(await b.late(), "b", "Closing one Location cannot retire another")
  await closeA()
  assert.deepEqual(a.counts(), { setupCount: 1, cleanupCount: 1, calls: 1, finalizations: 1 })
  await closeB()
  assert.deepEqual(b.counts(), { setupCount: 1, cleanupCount: 1, calls: 2, finalizations: 0 })
  // Capturing setup cannot leak its services into the process-global runner.
  await assert.rejects(Effect.runPromise(Effect.scoped(acquireMissionNativeService())), /unavailable/)
})

test("native external-setup context sealing prevents acquisition before Promise setup", async () => {
  const f = fixture("sealed")
  // Published v2.0.24 core/src/plugin.ts:69-73 replaces, rather than augments,
  // the context with activation Scope + logging. Logging cannot grant services.
  await assert.rejects(Effect.runPromise(Effect.scoped(f.entry.effect(f.host).pipe(
    Effect.updateContext((context: Context.Context<Scope.Scope>) => Context.make(Scope.Scope, Context.get(context, Scope.Scope)).pipe(
      Context.add(Logger.CurrentLoggers, Context.get(context, Logger.CurrentLoggers)),
      Context.add(References.MinimumLogLevel, Context.get(context, References.MinimumLogLevel)),
    )),
    Effect.provideService(sessionTag, f.service), Effect.provideService(locationTag, f.location),
  ))), /Native Missions service unavailable/)
  assert.deepEqual(f.counts(), { setupCount: 0, cleanupCount: 0, calls: 0, finalizations: 0 })
})

test("plugin Scope outlives a native request, but only a fresh existing graph can fence future passages", async t => {
  const f = fixture("owner"), replacement = fixture("owner")
  let writes = 0
  Object.assign(f.service, { environment: (input: { variables: Record<string, string> }) => Effect.sync(() => {
    writes++
    return { ...input.variables }
  }) })
  const globalScope = await Effect.runPromise(Scope.make())
  const setupScope = await Effect.runPromise(Scope.make())
  const requestScope = await Effect.runPromise(Scope.make())
  const close = (scope: Scope.Closeable) => Effect.runPromise(Scope.close(scope, Exit.void))
  t.after(async () => { await close(requestScope); await close(setupScope); await close(globalScope) })
  let pluginScope!: Scope.Closeable
  const lifetime = new AbortController()
  // Setup needs ONLY its real activation Scope, not Session/Location services.
  const entry = Plugin.define({ id: "private.missions.scope-qualification", effect: () => Effect.gen(function* () {
    pluginScope = yield* Scope.fork(yield* Scope.Scope)
    yield* Scope.addFinalizer(pluginScope, Effect.sync(() => lifetime.abort()))
  }) })
  await Effect.runPromise(entry.effect(f.host).pipe(Effect.provideService(Scope.Scope, setupScope)))

  const ref = Location.Ref.make({ directory: f.location.directory })
  let selected = f, lookups = 0
  const rcMap = await Effect.runPromise(RcMap.make({ idleTimeToLive: Infinity,
    lookup: () => Effect.sync(() => {
      lookups++
      return Context.make(sessionTag, selected.service).pipe(Context.add(locationTag, selected.location))
    }),
  }).pipe(Effect.provideService(Scope.Scope, globalScope)))
  // Installed LayerMap.contextEffectOption is precisely RcMap.getOption.
  const locations = { rcMap, contextEffectOption: (key: Location.Ref) => RcMap.getOption(rcMap, key) }
  const mapTag = Context.Service<never, typeof locations>("@opencode/example/LocationServiceMap")
  // Fixture-only explicit loading. Passage reads below must NEVER call get.
  const graph = await Effect.runPromise(RcMap.get(rcMap, ref).pipe(Effect.provideService(Scope.Scope, requestScope)))
  const callerGraph = graph.pipe(Context.add(mapTag, locations), Context.add(Scope.Scope, requestScope))
  const retained = await Effect.runPromiseWith(callerGraph)(
    acquireMissionNativeService().pipe(Effect.provideService(Scope.Scope, pluginScope)))
  // Only the native call supplies this map/owner identity. No fabricated setup
  // graph, authority grant, signed intent, enrollment ACK, or cold-wake claim.
  const enrollment = await Effect.runPromiseWith(callerGraph)(Effect.gen(function* () {
    return { locations: yield* mapTag, origin: yield* locationTag, session: yield* sessionTag }
  }))
  await close(requestScope)
  assert.equal((await retained.get({ sessionID: "ses_owner" })).id, "ses_owner")

  // Concrete per-passage read prototype, not an exported generic Effect runner.
  // Admission composition must retain its real epoch/root/grant guards and use
  // this short lease for admitAutonomousMissionInput, never the retained handle.
  const passage = Effect.fn("fixture.missionPassageRead")(function* (invalidateBeforeWrite = false) {
    return yield* Effect.acquireUseRelease(Scope.fork(pluginScope), scope => Effect.gen(function* () {
      lifetime.signal.throwIfAborted()
      if (rcMap.state._tag !== "Open") return yield* Effect.fail(new Error("Native map closed"))
      const token = MutableHashMap.get(rcMap.state.map, ref)
      if (Option.isNone(token)) return yield* Effect.fail(new Error("Location no longer loaded"))
      const found = yield* enrollment.locations.contextEffectOption(ref)
      if (Option.isNone(found)) return yield* Effect.fail(new Error("Location no longer loaded"))
      const current = found.value
      if (Context.get(current, locationTag) !== enrollment.origin
        || Context.get(current, sessionTag) !== enrollment.session) {
        return yield* Effect.fail(new Error("Native owner graph replaced"))
      }
      const native = yield* acquireMissionNativeService().pipe(Effect.provide(current))
      const assertCurrent = (): true => {
        lifetime.signal.throwIfAborted()
        native.assertCurrent()
        if (rcMap.state._tag !== "Open") throw new Error("Native map closed")
        const latest = MutableHashMap.get(rcMap.state.map, ref)
        if (Option.isNone(latest) || latest.value !== token.value) throw new Error("Native map lease invalidated")
        return true
      }
      // This callback checks the actual map entry at native call-entry. It is a
      // channel-lifetime guard, NOT a grant/signature/protected-owner substitute.
      if (invalidateBeforeWrite) yield* RcMap.invalidate(rcMap, ref)
      yield* Effect.promise(() => native.environment({ sessionID: "ses_owner", variables: { MARKER: "fixture" } },
        { signal: lifetime.signal }, assertCurrent))
      return yield* Effect.promise(() => native.get({ sessionID: "ses_owner" }, { signal: lifetime.signal }))
    }).pipe(Effect.provideService(Scope.Scope, scope)), scope => Scope.close(scope, Exit.void))
  })
  assert.equal((await Effect.runPromise(passage())).id, "ses_owner")
  assert.equal(lookups, 1)
  await assert.rejects(Effect.runPromise(passage(true)), /policy-unqualified/)
  assert.equal(writes, 1, "Invalidation during preparation must fence the actual native write")
  // Decisive counterexample: plugin Scope alone is NOT current map ownership.
  assert.equal((await retained.get({ sessionID: "ses_owner" })).id, "ses_owner")
  await assert.rejects(Effect.runPromise(passage()), /no longer loaded/)
  assert.equal(lookups, 1, "Missing Location must not be loaded by a due passage")
  selected = replacement
  await Effect.runPromise(Effect.scoped(RcMap.get(rcMap, ref)))
  await assert.rejects(Effect.runPromise(passage()), /owner graph replaced/)
  assert.equal(replacement.counts().calls, 0, "A replacement needs its own native enrollment")
  await close(setupScope)
  assert(lifetime.signal.aborted)
  await assert.rejects(retained.get({ sessionID: "ses_owner" }), /authorization-blocked/)
  await assert.rejects(Effect.runPromise(passage()))
})
