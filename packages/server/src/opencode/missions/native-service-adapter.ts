import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import type { NativeMissionSession } from "../../missions/control-types"
import { rejectAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import type { AutonomousMissionCommand } from "./autonomous-contract"

// Same existing private graph lookup as session-pruning/pending-snapshot.ts.
// No Core imports, HTTP/self-auth, credentials, database writer or version gate.
const sessionTag = Context.Service<never, unknown>("@opencode/Session")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
type NativeEffect = Effect.Effect<unknown, unknown>
type NativeSessionService = {
  get(id: string): NativeEffect
  environment(input: { sessionID: string; variables: Record<string, string> }): NativeEffect
  prompt(input: AutonomousMissionCommand["input"]): NativeEffect
  synthetic(input: AutonomousMissionCommand["input"]): NativeEffect
  inbox(id: string): NativeEffect
}
const method = Schema.declare<(input: never) => NativeEffect>((value): value is (input: never) => NativeEffect => Predicate.isFunction(value))
const serviceShape = Schema.Struct({ get: method, environment: method, prompt: method, synthetic: method, inbox: method })
const nativeEffect = Schema.declare<NativeEffect>((value): value is NativeEffect => Effect.isEffect(value))
const variablesShape = Schema.Record(Schema.String, Schema.String)

/** Acquire INSIDE an existing native Effect plugin/RPC context. Captures only its
 * real service graph; a bare Promise/Effect.runPromise cannot fabricate it. Scope
 * finalization retires captured sends before release. This is a native capability,
 * not a human authorization or protected grant; the admission helper supplies those.
 * Existing Session.environment/get/inbox/prompt/synthetic contracts are validated
 * by shape and result codecs, not the runtime version or an invented ctx field. */
export const acquireMissionNativeService = Effect.fn("missions.acquireNativeService")(function* () {
  const found = yield* Effect.serviceOption(sessionTag)
  const origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(found) || Option.isNone(origin)) return yield* Effect.fail(new Error("Native Missions service unavailable"))
  yield* Schema.decodeUnknownEffect(serviceShape)(found.value)
  // Location.Info is a class: native and bundled constructors differ. Validate
  // its actual structural fields rather than requiring a copy-local instance.
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  const service = found.value as NativeSessionService
  const graph = yield* Effect.context<never>()
  let active = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const assertCurrent = () => {
    if (!active || Context.get(graph, sessionTag) !== service || Context.get(graph, locationTag) !== origin.value) {
      rejectAuthority("authorization-blocked")
    }
    return true as const
  }
  const run = <A>(operation: () => NativeEffect, decode: Schema.Codec<A, unknown>,
    options: { signal?: AbortSignal } | undefined, current: () => true) => {
    const effect = Effect.gen(function* () {
      yield* Effect.sync(() => { options?.signal?.throwIfAborted(); assertCurrent(); assertSynchronousAuthorityGuard(current, "policy-unqualified") })
      // Invoke the actual native method only AFTER the synchronous call-entry fence.
      const result = yield* Schema.decodeUnknownEffect(nativeEffect)(yield* Effect.sync(operation))
      return yield* Schema.decodeUnknownEffect(decode)(yield* result)
    })
    return Effect.runPromise(Effect.provide(effect, graph), { signal: options?.signal })
  }
  return {
    location,
    assertCurrent,
    get: async (input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<NativeMissionSession> => {
      const session = await run(() => service.get(input.sessionID), Schema.toType(Session.Info), options, assertCurrent)
      return { id: session.id, projectID: session.projectID, location: { directory: session.location.directory,
        ...(session.location.workspaceID === undefined ? {} : { workspaceID: session.location.workspaceID }) },
        ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
        ...(session.agent === undefined ? {} : { agent: session.agent }),
        ...(session.model === undefined ? {} : { model: { ...session.model } }) }
    },
    inbox: (sessionID: string, options?: { signal?: AbortSignal }) =>
      run(() => service.inbox(sessionID), Schema.Array(Schema.toType(SessionInbox.Info)).check(Schema.isMaxLength(1024)), options, assertCurrent),
    environment: async (input: { sessionID: string; variables: Record<string, string> },
      options: { signal?: AbortSignal }, current: () => true) => {
      const variables = { ...input.variables }
      const result = await run(() => service.environment({ sessionID: input.sessionID, variables }), variablesShape, options, current)
      if (!isDeepStrictEqual(result, variables)) rejectAuthority("effect-unavailable")
    },
    admit: async (command: AutonomousMissionCommand, options: { signal?: AbortSignal }, current: () => true) => {
      const input = structuredClone(command.input)
      const receipt = await run(() => command.kind === "prompt" ? service.prompt(input) : service.synthetic(input),
        Schema.toType(SessionInbox.Info), options, current)
      if (receipt.id !== input.id || receipt.sessionID !== input.sessionID
        || receipt.type !== (command.kind === "prompt" ? "user" : "synthetic")) rejectAuthority("effect-unavailable")
      return receipt
    },
  }
})
export type MissionNativeService = Effect.Success<ReturnType<typeof acquireMissionNativeService>>
