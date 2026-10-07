// Native Effect plugin probe: bounded marker clock, no dispatch, keepalive or claim writes.
import assert from "node:assert/strict"
import path from "node:path"
import { Cause, Context, Effect, Exit, MutableHashMap, Option, Predicate, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { readClaimEnrollment } from "./claim-plugin.mjs"
import { TIMER_CAPTURE_RPC } from "./timer-scope.mjs"
import emit from "./emit.cjs"

emit.module("timer-plugin-module", import.meta.url)

// Read-only exact v2.0.24 contracts. Never import Core or construct a missing graph.
const mapTag = Context.Service("@opencode/example/LocationServiceMap")
const locationTag = Context.Service("@opencode/Location")
const lifecycleTag = Context.Service("@opencode/LocationLifecycle")
const callable = Schema.declare(Predicate.isFunction)
const rcMapShape = Schema.Struct({ "~effect/RcMap": Schema.Literal("~effect/RcMap"), state: Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Closed") }),
  Schema.Struct({ _tag: Schema.Literal("Open"), map: Schema.declare(MutableHashMap.isMutableHashMap) }),
]) })
const mapShape = Schema.Struct({ contextEffectOption: callable, rcMap: rcMapShape })
const lifecycleShape = Schema.Struct({ isClosed: callable })
const contextShape = Schema.declare(Context.isContext)
const contextOption = Schema.Option(contextShape)
const effectShape = Schema.declare(Effect.isEffect)
const entryFor = (map, ref) => map.rcMap.state._tag === "Open"
  ? Option.getOrUndefined(MutableHashMap.get(map.rcMap.state.map, ref)) : undefined

export default {
  id: "missions.native-claim-fixture",
  effect: Effect.fn("fixture.timerPlugin")(function* (ctx) {
    const root = process.env.NATIVE_STARTUP_ROOT, nonce = process.env.NATIVE_STARTUP_NONCE
    const directory = ctx.location.directory
    assert.ok(["project", "idle-project"].some(name => path.resolve(root, name) === path.resolve(directory)))
    emit("claim-plugin-setup", directory)
    const scope = yield* Effect.scope
    const key = `timer-fixture/${nonce}/${directory}`
    const enrollmentShape = Schema.Struct({ nonce: Schema.Literal(nonce), directory: Schema.Literal(directory),
      sessionID: Schema.String, permissionID: Schema.String, action: Schema.Literal("bounded-markers-only") })
    const decode = Schema.decodeUnknownSync(enrollmentShape)
    const saved = yield* ctx.storage.get(key)
    const enrollment = saved === undefined ? undefined : decode(saved)
    let live = true, captured
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      live = false
      emit("timer-plugin-finalized", directory)
    }))
    yield* ctx.session.hook("http.request", event => Effect.sync(() => {
      event.request.headers.set("x-claim-kind", event.kind)
      event.request.headers.set("x-claim-session", event.sessionID)
    }))
    // Setup and provider hooks do not carry this graph. One exact authenticated native RPC
    // captures references; it neither forks the clock nor retains a Location lease.
    yield* ctx.rpc.register(TIMER_CAPTURE_RPC, { capture: (input, call) => Effect.gen(function* () {
      assert.equal(input.nonce, nonce)
      assert.equal(input.pid, process.pid)
      assert.ok(live && enrollment)
      assert.equal(input.sessionID, enrollment.sessionID)
      const map = yield* Effect.serviceOption(mapTag)
      const origin = yield* Effect.serviceOption(locationTag)
      const lifecycle = yield* Effect.serviceOption(lifecycleTag)
      if ([map, origin, lifecycle].some(Option.isNone)) {
        emit("timer-graph-unavailable", directory)
        return yield* Effect.fail(call.error("unavailable", "Fixture native graph unavailable", {}))
      }
      Schema.decodeUnknownSync(mapShape)(map.value)
      Schema.decodeUnknownSync(lifecycleShape)(lifecycle.value)
      assert.equal(origin.value.directory, directory)
      assert.equal(origin.value.workspaceID, ctx.location.workspaceID)
      const ref = Location.Ref.make({ directory: path.normalize(directory), workspaceID: ctx.location.workspaceID })
      const entry = entryFor(map.value, ref)
      assert.ok(entry, "Exact RcMap entry token exists")
      const current = yield* map.value.contextEffectOption(ref)
      assert.ok(Option.isSome(current))
      assert.equal(Context.get(current.value, locationTag), origin.value)
      assert.equal(Context.get(current.value, lifecycleTag), lifecycle.value)
      assert.equal(entryFor(map.value, ref), entry)
      captured = { map: map.value, ref, entry, origin: origin.value, lifecycle: lifecycle.value }
      emit("timer-graph-captured", directory, { sessionID: enrollment.sessionID })
      return { pid: process.pid, directory }
    }).pipe(Effect.scoped, Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.interrupt
      : Effect.fail(call.error("unavailable", "Fixture native graph refused", {})))) })
    if (enrollment) {
      emit("timer-storage-rearmed", directory, { sessionID: enrollment.sessionID })
      const tick = Effect.fn("fixture.loadedOnlyTick")(function* () {
        if (!live || !captured) { emit("timer-tick-denied", directory); return }
        if (entryFor(captured.map, captured.ref) !== captured.entry) { emit("timer-tick-denied-stale-entry", directory); return }
        // Loaded-only is a probe control, not a policy prohibiting explicitly authorized cold-root acquire.
        const lease = yield* Schema.decodeUnknownEffect(effectShape)(captured.map.contextEffectOption(captured.ref))
        const found = yield* Schema.decodeUnknownEffect(contextOption)(yield* lease)
        if (Option.isNone(found)) { emit("timer-tick-denied-missing-entry", directory); return }
        const origin = Context.get(found.value, locationTag), lifecycle = Context.get(found.value, lifecycleTag)
        Schema.decodeUnknownSync(lifecycleShape)(lifecycle)
        const fresh = decode(yield* ctx.storage.get(key))
        if (!live || origin !== captured.origin || lifecycle !== captured.lifecycle || lifecycle.isClosed()
          || entryFor(captured.map, captured.ref) !== captured.entry
          || fresh.sessionID !== enrollment.sessionID || fresh.permissionID !== enrollment.permissionID) {
          emit("timer-tick-denied-stale-entry", directory)
          return
        }
        // Only the nonce marker is an effect; these checks are NOT Mission execution authority.
        emit("timer-tick", directory, { sessionID: fresh.sessionID })
      }, Effect.scoped)
      yield* Effect.gen(function* () {
        yield* Effect.sleep("6 seconds")
        for (let index = 0; index < 3; index++) {
          yield* tick()
          if (index < 2) yield* Effect.sleep("3 seconds")
        }
      }).pipe(Effect.forkIn(scope))
    }
    yield* ctx.tool.transform(editor => editor.add({
      name: "fixture_hold", description: "One consent-bound fixture hold; enroll harmless native markers only.",
      input: { type: "object", properties: { nonce: { type: "string", const: nonce } }, required: ["nonce"], additionalProperties: false },
      options: { codemode: false, permission: "fixture_hold" },
      execute: Effect.fn("fixture.hold")(function* (input, context) {
        const authorized = yield* Effect.promise(() => readClaimEnrollment(input, context, directory))
        yield* ctx.storage.set(key, decode({ nonce, directory, sessionID: context.sessionID,
          permissionID: authorized.permission.id, action: "bounded-markers-only" }))
        emit("timer-storage-enrolled", directory, context)
        emit("claim-tool-enter", directory, context)
        yield* Effect.sleep("1 minute").pipe(Effect.onExit(exit => Effect.sync(() => {
          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) emit("claim-tool-aborted", directory, context)
        })))
        emit("claim-tool-timeout", directory, context)
        return { content: "Fixture hold expired" }
      }),
    }))
  }),
}
