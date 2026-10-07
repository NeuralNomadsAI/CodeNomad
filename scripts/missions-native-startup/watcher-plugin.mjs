// Fixture-only standing execution: awaited native callback, never an escaped owner.
import assert from "node:assert/strict"
import path from "node:path"
import { Cause, Context, Effect, Exit, Option, Predicate, Schema } from "effect"
import { readClaimEnrollment } from "./claim-plugin.mjs"
import { WATCHER_PARK_RPC } from "./watcher-scope.mjs"
import emit from "./emit.cjs"

emit.module("watcher-plugin-module", import.meta.url)
const mapTag = Context.Service("@opencode/example/LocationServiceMap")
const locationTag = Context.Service("@opencode/Location")
const lifecycleTag = Context.Service("@opencode/LocationLifecycle")
const lifecycleShape = Schema.Struct({ isClosed: Schema.declare(Predicate.isFunction) })

export default {
  id: "missions.native-claim-fixture",
  effect: Effect.fn("fixture.watcherPlugin")(function* (ctx) {
    const root = process.env.NATIVE_STARTUP_ROOT, nonce = process.env.NATIVE_STARTUP_NONCE
    const directory = ctx.location.directory
    assert.ok(["project", "idle-project"].some(name => path.resolve(root, name) === path.resolve(directory)))
    const pluginScope = yield* Effect.scope
    const key = `watcher-fixture/${nonce}/${directory}`
    const decode = Schema.decodeUnknownSync(Schema.Struct({ nonce: Schema.Literal(nonce), directory: Schema.Literal(directory),
      sessionID: Schema.String, permissionID: Schema.String, active: Schema.Boolean }))
    emit("claim-plugin-setup", directory)
    yield* Effect.addFinalizer(() => Effect.sync(() => emit("watcher-plugin-finalized", directory)))
    yield* ctx.session.hook("http.request", event => Effect.sync(() => {
      event.request.headers.set("x-claim-kind", event.kind)
      event.request.headers.set("x-claim-session", event.sessionID)
    }))
    // Explicit fixture park only. A nonce/permission receipt is NOT signer/writer authority.
    const validate = Effect.fn("fixture.watcherInput")(function* (input) {
      assert.equal(input.nonce, nonce)
      assert.equal(input.pid, process.pid)
      const saved = decode(yield* ctx.storage.get(key))
      assert.equal(input.sessionID, saved.sessionID)
      assert.equal(saved.active, true)
      return saved
    })
    const refuse = cause => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.die(Cause.squash(cause))
    yield* ctx.rpc.register(WATCHER_PARK_RPC, { park: (input, call) => Effect.gen(function* () {
      const saved = yield* validate(input)
      yield* ctx.storage.set(key, { ...saved, active: false })
      emit("watcher-explicitly-parked", directory, { sessionID: saved.sessionID })
      return { pid: process.pid, directory }
    }).pipe(Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.interrupt
      : Effect.fail(call.error("unavailable", "Fixture park refused", {})))),
    hold: input => Effect.gen(function* () {
      const saved = yield* validate(input)
      const lifecycle = yield* lifecycleTag
      const origin = yield* locationTag
      assert.equal(origin.directory, directory)
      assert.equal(origin.workspaceID, ctx.location.workspaceID)
      assert.equal(lifecycle.isClosed(), false)
      yield* Effect.addFinalizer(() => Effect.sync(() => emit("watcher-execution-scope-finalized", directory, saved)))
      emit("watcher-resume-held-before-model", directory, saved)
      for (let index = 0; index < 22; index++) {
        assert.equal(lifecycle.isClosed(), false)
        emit("watcher-harmless-observation", directory, saved)
        yield* Effect.sleep("2 seconds")
      }
      yield* Effect.sleep("1 second")
      emit("watcher-bound-expired", directory, saved)
      return yield* Effect.interrupt
    }).pipe(Effect.scoped, Effect.catchCause(refuse)) })
    yield* ctx.session.hook("context", Effect.fn("fixture.watcherContext")(function* (event) {
      const inheritedScope = yield* Effect.scope
      const map = yield* Effect.serviceOption(mapTag)
      const origin = yield* Effect.serviceOption(locationTag)
      const lifecycle = yield* Effect.serviceOption(lifecycleTag)
      for (const [name, option] of [["map", map], ["location", origin], ["lifecycle", lifecycle]])
        emit(`watcher-hook-${name}-${Option.isSome(option) ? "available" : "missing"}`, directory, event)
      if ([origin, lifecycle].some(Option.isNone)) {
        emit("watcher-hook-graph-unavailable", directory, event)
        return
      }
      Schema.decodeUnknownSync(lifecycleShape)(lifecycle.value)
      assert.equal(origin.value.directory, directory)
      assert.equal(origin.value.workspaceID, ctx.location.workspaceID)
      assert.notEqual(inheritedScope, pluginScope, "Hook inherits native drain Scope, not plugin setup Scope")
      emit("watcher-native-drain-scope-distinct-from-plugin", directory, event)
      emit("watcher-hook-native-graph", directory, event)
      const stored = yield* ctx.storage.get(key)
      if (stored === undefined) return
      const enrolled = decode(stored)
      if (!enrolled.active || event.sessionID !== enrolled.sessionID) return
      const authorized = yield* Effect.promise(() => readClaimEnrollment({ nonce }, event, directory))
      assert.equal(enrolled.permissionID, authorized.permission.id)
      assert.equal(lifecycle.value.isClosed(), false)
      // Existing local RPC races shutdown (rpc.ts:132-137), even with a borrowed graph.
      // Root-local proof only: no global map capture, due-root acquire or stale-graph dispatch.
      yield* ctx.rpc(WATCHER_PARK_RPC).hold({ nonce, sessionID: event.sessionID, pid: process.pid }).pipe(
        Effect.catch(error => {
          if (!lifecycle.value.isClosed()) return Effect.die(error)
          emit("watcher-location-rpc-shutdown-cancel", directory, event)
          return Effect.interrupt
        }), Effect.onExit(exit => Effect.sync(() => {
          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) emit("watcher-hook-interrupted", directory, event)
        })))
    }))
    yield* ctx.tool.transform(editor => editor.add({
      name: "fixture_hold", description: "One explicit fixture enrollment; never resume this tool.",
      input: { type: "object", properties: { nonce: { type: "string", const: nonce } }, required: ["nonce"], additionalProperties: false },
      options: { codemode: false, permission: "fixture_hold" },
      execute: Effect.fn("fixture.watcherEnrollment")(function* (input, context) {
        const authorized = yield* Effect.promise(() => readClaimEnrollment(input, context, directory))
        yield* ctx.storage.set(key, decode({ nonce, directory, sessionID: context.sessionID,
          permissionID: authorized.permission.id, active: true }))
        emit("claim-tool-enter", directory, context)
        yield* Effect.sleep("1 minute")
        emit("claim-tool-timeout", directory, context)
        return { content: "Fixture enrollment bound expired" }
      }),
    }))
  }),
}
