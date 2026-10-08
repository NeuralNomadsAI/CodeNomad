import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import type { NativeMissionSession } from "../../missions/control-types"
import { canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"
import { matchesExecution } from "../../missions/execution"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import type { AutonomousMissionCommand } from "./autonomous-contract"

// Same existing private graph lookup as session-pruning/pending-snapshot.ts.
// No Core imports, HTTP/self-auth, credentials, database writer or version gate.
const sessionTag = Context.Service<never, unknown>("@opencode/Session")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
type NativeEffect = Effect.Effect<unknown, unknown>
type NativeSessionService = {
  get(id: string): NativeEffect
  create(input: NativeCreateInput): NativeEffect
  environment(input: { sessionID: string; variables: Record<string, string> }): NativeEffect
  prompt(input: AutonomousMissionCommand["input"]): NativeEffect
  synthetic(input: AutonomousMissionCommand["input"] | NativeRecurrenceLifecycleCommand["input"]): NativeEffect
  inbox(id: string): NativeEffect
}
export type NativeCreateInput = {
  id: string; title: string; location: { directory: string }; metadata: Record<string, unknown>
  agent: string; model: { providerID: string; id: string; variant?: string }
}
export type NativeRootPlacement = Pick<NativeCreateInput, "id" | "agent" | "model" | "metadata"> & {
  projectID: string; location: { directory: string; workspaceID?: string }
}
export type NativeRecurrenceLifecycleCommand = { kind: "synthetic"; input: {
  sessionID: string; id: string; text: string; description: string; delivery: "queue"; resume: true
  metadata: { "codenomad.mission": { version: 1; missionID: string; kind: "lifecycle"; operationID: string;
    taskMode: "native" | "independent";
    recurrence: { grantID: string; passageID: string; messageID: string; coordinatorSessionID: string } } }
} }
const method = Schema.declare<(input: never) => NativeEffect>((value): value is (input: never) => NativeEffect => Predicate.isFunction(value))
const serviceShape = Schema.Struct({ get: method, create: method, environment: method, prompt: method, synthetic: method, inbox: method })
const variablesShape = Schema.Record(Schema.String, Schema.String)

/** Acquire INSIDE an existing native Effect plugin/RPC context. Captures only its
 * real service graph; a bare Promise/Effect.runPromise cannot fabricate it. Scope
 * finalization retires captured sends before release. This is a native capability,
 * not a human authorization or protected grant; the admission helper supplies those.
  * Existing Session.create/environment/get/inbox/prompt/synthetic contracts are validated
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
    options: { signal?: AbortSignal } | undefined, current: () => true, expected?: NativeRootPlacement) => {
    const pinned = expected && structuredClone(expected)
    const effect = Effect.gen(function* () {
      // The native get is preparation; a moved/retargeted root is rejected in
      // the SAME synchronous callback that invokes the native mutation.
      const session = pinned ? yield* Schema.decodeUnknownEffect(Schema.toType(Session.Info))(yield* service.get(pinned.id)) : undefined
      const prepared = yield* Effect.sync(operation)
      if (!Effect.isEffect(prepared)) rejectAuthority("effect-unavailable")
      // Native methods construct lazy Effects. Recheck AFTER construction and
      // consume the one-use fence in the suspension evaluated immediately
      // before the native Effect, with no intervening asynchronous codec read.
      const result = yield* Effect.suspend(() => {
        options?.signal?.throwIfAborted(); assertCurrent()
        if (pinned && (!session || session.id !== pinned.id || session.parentID
          || session.projectID !== pinned.projectID || session.location.directory !== pinned.location.directory
          || session.location.workspaceID !== pinned.location.workspaceID
          || !matchesExecution(pinned, session) || !isDeepStrictEqual(session.metadata, pinned.metadata))) {
          rejectAuthority("binding-mismatch")
        }
        assertSynchronousAuthorityGuard(current, "policy-unqualified")
        return prepared
      })
      return yield* Schema.decodeUnknownEffect(decode)(result)
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
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.metadata === undefined ? {} : { metadata: JSON.parse(canonicalAuthority(session.metadata)) as NativeMissionSession["metadata"] }),
        ...(session.agent === undefined ? {} : { agent: session.agent }),
        ...(session.model === undefined ? {} : { model: { ...session.model } }) }
    },
    inbox: (sessionID: string, options?: { signal?: AbortSignal }) =>
      run(() => service.inbox(sessionID), Schema.Array(Schema.toType(SessionInbox.Info)).check(Schema.isMaxLength(1024)), options, assertCurrent),
    create: async (input: NativeCreateInput, options: { signal?: AbortSignal }, current: () => true) => {
      const request = structuredClone(input)
      const session = await run(() => service.create(request), Schema.toType(Session.Info), options, current)
      if (session.id !== request.id || session.parentID || session.projectID !== location.project.id
        || session.location.directory !== request.location.directory || session.location.workspaceID !== location.workspaceID
        || !matchesExecution(request, session)
        || !isDeepStrictEqual(session.metadata, request.metadata)) rejectAuthority("effect-unavailable")
      return session
    },
    environment: async (input: { sessionID: string; variables: Record<string, string> },
      options: { signal?: AbortSignal }, current: () => true, expected?: NativeRootPlacement) => {
      const variables = { ...input.variables }
      if (expected && input.sessionID !== expected.id) rejectAuthority("binding-mismatch")
      const result = await run(() => service.environment({ sessionID: input.sessionID, variables }), variablesShape, options, current, expected)
      if (!isDeepStrictEqual(result, variables)) rejectAuthority("effect-unavailable")
    },
    admit: async (command: AutonomousMissionCommand | NativeRecurrenceLifecycleCommand, options: { signal?: AbortSignal },
      current: () => true, expected?: NativeRootPlacement) => {
      const input = structuredClone(command.input)
      if (expected && input.sessionID !== expected.id) rejectAuthority("binding-mismatch")
      const receipt = await run(() => command.kind === "prompt" ? service.prompt(input as AutonomousMissionCommand["input"])
        : service.synthetic(input),
        Schema.toType(SessionInbox.Info), options, current, expected)
      if (receipt.id !== input.id || receipt.sessionID !== input.sessionID
        || receipt.type !== (command.kind === "prompt" ? "user" : "synthetic")) rejectAuthority("effect-unavailable")
      return receipt
    },
  }
})
export type MissionNativeService = Effect.Success<ReturnType<typeof acquireMissionNativeService>>
