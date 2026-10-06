import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, RcMap, Schema, Scope } from "effect"
import { Location, type Plugin } from "@opencode/plugin/effect"
import { PendingSnapshotRpc, readPendingSnapshot, registerPendingSnapshot } from "./pending-snapshot"
import { desktopPlugin } from "./desktop-plugin"
import { PRESENCE_EXPIRY_MS, PRESENCE_INTERVAL_MS } from "./presence"

const mapTag = Context.Service<never, unknown>("@opencode/example/LocationServiceMap")
class locationTag extends Context.Service<locationTag, unknown>()("@opencode/Location") {}
class formTag extends Context.Service<formTag, unknown>()("@opencode/Form") {}
class permissionTag extends Context.Service<permissionTag, unknown>()("@opencode/Permission") {}
const root = path.resolve("pending-snapshot-unit-only")
const ref = (name: string, workspaceID?: string) => Schema.decodeUnknownSync(Location.Ref)({ directory: path.join(root, name), ...(workspaceID ? { workspaceID } : {}) })
const origin = ref("bootstrap")
const input = (...refs: Location.Ref[]) => ({ directories: [...new Set(refs.map((ref) => ref.directory))] })
const form = { id: "frm_pending", sessionID: "global", title: "Idle global form", fields: [{ key: "value", type: "number", minimum: -Infinity, maximum: Infinity, default: NaN }] }
const permission = { id: "per_pending", sessionID: "ses_idle", action: "fixture", resources: [] }
const good = (ref: Location.Ref, permissions = () => Effect.succeed<unknown>([permission]), forms = () => Effect.succeed<unknown>([form])) =>
  Layer.succeedContext(Context.empty().pipe(Context.add(locationTag, ref), Context.add(formTag, { list: forms }), Context.add(permissionTag, { list: permissions })))
const read = (map: unknown, value: unknown) => readPendingSnapshot(value).pipe(
  Effect.provideService(mapTag, map), Effect.provideService(locationTag, origin),
)
const fails = Effect.fn("test.pendingSnapshot.fails")(function* (effect: Effect.Effect<unknown, unknown>) {
  const exit = yield* Effect.exit(effect)
  assert(Exit.isFailure(exit), "Incomplete discovery must never return empty success")
})

test("bounded existing-only queues preserve global forms, exact provenance, numeric codecs and cold coverage", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let builds = 0
    const loaded = ref("loaded"), explicit = ref("loaded", "wrk_fixture")
    const map = yield* LayerMap.make((ref: Location.Ref) => { builds++; return Layer.fresh(good(ref)) }, { idleTimeToLive: "1 hour" })
    yield* map.contextEffect(loaded)
    yield* map.contextEffect(explicit)
    const cold = Array.from({ length: 100 }, (_, n) => ref(`cold-${n}`))
    for (const batch of [cold.slice(0, 60), cold.slice(60)]) {
      const output = yield* read(map, input(loaded, ...batch))
      assert.deepEqual(output, { originDirectory: origin.directory, data: [
        { directory: loaded.directory, status: "complete", locations: [loaded, explicit].map((location) => ({
          location: { directory: location.directory, ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}) },
          forms: [{ ...form, fields: [{ key: "value", type: "number", minimum: "-Infinity", maximum: "Infinity", default: "NaN" }] }], permissions: [permission],
        })) }, ...batch.map((ref) => ({ directory: ref.directory, status: "complete", locations: [] })),
      ] })
    }
    assert.equal(builds, 2)
    if (process.platform === "win32") {
      const spelling = loaded.directory.replaceAll("\\", "/").toUpperCase()
      const output = yield* read(map, { directories: [spelling] })
      assert.equal((output as { data: Array<{ directory: string }> }).data[0].directory, spelling)
      assert.equal((output as { data: Array<{ locations: unknown[] }> }).data[0].locations.length, 2)
    }
    yield* fails(read(map, { directories: [] }))
    yield* fails(read(map, { directories: Array(65).fill(loaded.directory) }))
    yield* fails(read(map, { directories: ["relative"] }))
    yield* fails(read(map, { directories: [`${loaded.directory}\0`] }))
    yield* fails(read(map, { ...input(loaded), version: "2.0.22" }))
  })))
})

test("context, graph, shape, encoding, limits and timeout failures remain non-authoritative", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const loaded = ref("loaded")
    yield* fails(readPendingSnapshot(input(loaded)))
    yield* fails(read({}, input(loaded)))
    const unknown = yield* LayerMap.make(() => good(loaded), { idleTimeToLive: "1 hour" })
    yield* unknown.contextEffect("changed-key-format")
    yield* fails(read(unknown, input(loaded)))
    const broken = yield* LayerMap.make((_: Location.Ref) => Layer.effectContext(Effect.die("private graph failure")), { idleTimeToLive: "1 hour" })
    yield* broken.contextEffect(loaded).pipe(Effect.exit)
    yield* fails(read(broken, input(loaded)))
    for (const list of [
      () => Effect.die("private queue failure"),
      () => Effect.succeed([{ ...permission, metadata: { secret: 1n } }]),
      () => Effect.succeed([{ ...permission, metadata: { silentlyOmitted: undefined } }]),
      () => Effect.succeed(Array(1025).fill(permission)),
      () => Effect.succeed([{ ...permission, message: "x".repeat(4 * 1024 * 1024) }]),
      () => Effect.never,
    ]) {
      const map = yield* LayerMap.make((ref: Location.Ref) => good(ref, list), { idleTimeToLive: "1 hour" })
      yield* map.contextEffect(loaded)
      yield* fails(read(map, input(loaded)))
    }
    const closedScope = yield* Scope.make()
    const closed = yield* LayerMap.make((ref: Location.Ref) => good(ref)).pipe(Effect.provideService(Scope.Scope, closedScope))
    yield* Scope.close(closedScope, Exit.void)
    const closedRead = yield* Effect.exit(read(closed, input(loaded)))
    assert(Exit.isFailure(closedRead) && Cause.hasInterruptsOnly(closedRead.cause))
  })))
})

test("eviction and same-key replacement never construct absent candidates; cancellation releases leases", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const loaded = ref("loaded")
    for (const replace of [false, true]) {
      let builds = 0
      const entered = yield* Deferred.make<void>(), release = yield* Deferred.make<void>()
      const map = yield* LayerMap.make((ref: Location.Ref) => {
        const generation = ++builds
        return Layer.fresh(good(ref, () => generation === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as([])) : Effect.succeed([])))
      }, { idleTimeToLive: "1 hour" })
      yield* map.contextEffect(loaded)
      const reading = yield* read(map, input(loaded)).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* map.invalidate(loaded)
      if (replace) yield* map.contextEffect(loaded)
      yield* Deferred.succeed(release, undefined)
      yield* fails(Fiber.join(reading))
      assert.equal(builds, replace ? 2 : 1)
      assert.equal(Array.from(yield* RcMap.keys(map.rcMap)).length, replace ? 1 : 0)
    }
    let builds = 0
    const evicted = yield* LayerMap.make((ref: Location.Ref) => { builds++; return good(ref) }, { idleTimeToLive: "1 hour" })
    yield* evicted.contextEffect(loaded)
    yield* fails(read({ ...evicted, contextEffectOption: (key: Location.Ref) => evicted.invalidate(key).pipe(Effect.andThen(evicted.contextEffectOption(key))) }, input(loaded)))
    assert.equal(builds, 1)
    const started = yield* Deferred.make<void>()
    const cancelled = yield* LayerMap.make((ref: Location.Ref) => good(ref, () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))), { idleTimeToLive: "0 millis" })
    const seedScope = yield* Scope.make()
    yield* cancelled.contextEffect(loaded).pipe(Effect.provideService(Scope.Scope, seedScope))
    const reading = yield* read(cancelled, input(loaded)).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* Scope.close(seedScope, Exit.void)
    yield* Fiber.interrupt(reading)
    assert(Exit.isFailure(yield* Fiber.await(reading)))
    assert.equal(Array.from(yield* RcMap.keys(cancelled.rcMap)).length, 0)
  })))
})

test("registration requires native RPC capability and invalidates already-admitted callbacks on disposal", async () => {
  const registrations: Array<{ definition: unknown; handlers: any; dispose: boolean }> = []
  const rpc = Object.assign(() => {}, { register: (definition: unknown, handlers: unknown) => Effect.acquireRelease(
    Effect.sync(() => { const entry = { definition, handlers, dispose: false }; registrations.push(entry); return entry }),
    (entry) => Effect.sync(() => { entry.dispose = true }),
  ).pipe(Effect.as({ dispose: Effect.void, events: { emit: () => Effect.void } })) })
  const ctx = (version: string) => ({ app: { version }, rpc }) as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerPendingSnapshot({ app: { version: "2.0.22" }, rpc: {} } as unknown as Plugin.Context)))
  assert.equal(registrations.length, 0)
  const scope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(registerPendingSnapshot(ctx("2.0.22")).pipe(Effect.provideService(Scope.Scope, scope)))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].definition, PendingSnapshotRpc)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const loaded = ref("loaded")
    const entered = yield* Deferred.make<void>(), release = yield* Deferred.make<void>()
    const map = yield* LayerMap.make((ref: Location.Ref) => good(ref, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as([]))), { idleTimeToLive: "0 millis" })
    const seedScope = yield* Scope.make()
    yield* map.contextEffect(loaded).pipe(Effect.provideService(Scope.Scope, seedScope))
    const callback: Effect.Effect<unknown, unknown> = registrations[0].handlers.snapshot(input(loaded), { error: () => new Error("unavailable") })
    const reading = yield* callback.pipe(Effect.provideService(mapTag, map), Effect.provideService(locationTag, origin), Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* Scope.close(scope, Exit.void)
    yield* Scope.close(seedScope, Exit.void)
    yield* Deferred.succeed(release, undefined)
    yield* fails(Fiber.join(reading))
    assert.equal(Array.from(yield* RcMap.keys(map.rcMap)).length, 0, "Presence loss fences the admitted result and releases its leases")
  })))
  assert(registrations[0].dispose)
  const unavailable = await Effect.runPromise(Effect.exit(registrations[0].handlers.snapshot(input(origin), { error: () => new Error("unavailable") })))
  assert(Exit.isFailure(unavailable))
})

test("untested, custom and missing version labels do not block a capable reader", async () => {
  let registered = 0
  const rpc = Object.assign(() => {}, { register: (definition: unknown) => Effect.sync(() => {
    assert.equal(definition, PendingSnapshotRpc)
    registered++
  }) })
  const versions = [...Array.from({ length: 18 }, (_, index) => `2.0.${index + 7}`), "2.0.25", "2.0.24-dev.1", "custom", undefined]
  for (const version of versions) await Effect.runPromise(Effect.scoped(registerPendingSnapshot({ app: { version }, rpc } as unknown as Plugin.Context)))
  assert.equal(registered, versions.length)
  await Effect.runPromise(Effect.scoped(registerPendingSnapshot(new Proxy({ rpc }, {
    get(target, key) { if (key === "app") throw new Error("Version metadata must not be consulted"); return Reflect.get(target, key) },
  }) as unknown as Plugin.Context)))
  assert.equal(registered, versions.length + 1)
})

test("production entry shares one presence lifecycle for old/new RPCs, never double-registers and disposes scopes", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-pending-entry-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const a = path.join(directory, "abc.lease"), b = path.join(directory, "def.lease")
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() })
  const entries: Array<{ id: string; methods: string[]; closed: boolean }> = []
  let rejectNew = false
  const register = (definition: { id: string; methods: object }) => Effect.gen(function* () {
    if (rejectNew && definition.id === "codenomad.pending-requests") return yield* Effect.fail(new Error("Fixture registration failure"))
    const entry = { id: definition.id, methods: Object.keys(definition.methods).sort(), closed: false }
    entries.push(entry)
    const dispose = Effect.sync(() => { entry.closed = true })
    yield* Effect.addFinalizer(() => dispose)
    return { dispose, events: { emit: () => Effect.void } }
  })
  // All other native domains are inert: a hook/tool/API invocation fails this test immediately.
  const unused: any = new Proxy(() => { throw new Error("Unexpected native API or hook") }, { get: () => unused })
  const rpc = Object.assign(() => {}, { register })
  const ctx = new Proxy({ app: { version: "2.0.22" }, rpc, location: origin, options: {} }, {
    get: (target, property) => Reflect.get(target, property) ?? unused,
  }) as unknown as Plugin.Context
  const scope = await Effect.runPromise(Scope.make())
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void))
  t.after(close)
  await Effect.runPromise(desktopPlugin(directory).effect(ctx).pipe(Effect.provideService(Scope.Scope, scope)))
  assert.equal(entries.length, 0)
  const tick = async (check: () => boolean) => {
    monotonic += PRESENCE_INTERVAL_MS
    t.mock.timers.tick(PRESENCE_INTERVAL_MS)
    for (let n = 0; n < 100 && !check(); n++) await delay(5)
    assert(check(), "Expected serial presence reconciliation")
  }
  await fs.writeFile(a, "")
  await tick(() => entries.length === 2)
  assert.deepEqual(entries.map(entry => entry.id), ["codenomad.session-pruning", "codenomad.pending-requests"])
  assert.deepEqual(entries[0].methods, ["history", "outline", "outlinePreview", "preview", "prune", "pruneBatch", "window"])
  assert.deepEqual(entries[1].methods, ["snapshot"])
  await fs.writeFile(b, "")
  await fs.unlink(a)
  await tick(() => true)
  await delay(20)
  assert.equal(entries.length, 2)
  assert(entries.every(entry => !entry.closed), "Another backend lease retains both registrations")
  const expired = new Date(Date.now() - PRESENCE_EXPIRY_MS - 1000)
  await fs.utimes(b, expired, expired)
  await tick(() => entries.every(entry => entry.closed))
  await fs.writeFile(a, "returned")
  await tick(() => entries.length === 4)
  await tick(() => true)
  await delay(20)
  assert.equal(entries.length, 4, "Stable presence must not double-register")
  await close()
  assert(entries.every(entry => entry.closed))
  await tick(() => true)
  await delay(20)
  assert.equal(entries.length, 4, "Unloaded entry must not resurrect")
  await fs.utimes(a, new Date(Date.now()), new Date(Date.now()))
  for (const version of ["2.0.23", undefined]) {
    Object.assign(ctx.app, { version })
    await Effect.runPromise(Effect.scoped(desktopPlugin(directory).effect(ctx)))
    assert.equal(entries.at(-1)?.id, "codenomad.pending-requests", "Untested/missing version does not block loaded-only recovery")
    assert(entries.at(-1)?.closed)
  }
  Object.assign(ctx.app, { version: "2.0.22" })
  rejectNew = true
  await assert.rejects(Effect.runPromise(Effect.scoped(desktopPlugin(directory).effect(ctx))), /Fixture registration failure/)
  assert(entries.every(entry => entry.closed), "Failed partial setup must close the original Promise RPC scope")
})
