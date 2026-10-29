import { Context, Effect } from "effect"
import { acquireNativePassageObservation } from "../../packages/server/src/opencode/missions/native-passage-observation"
import { definition } from "./definition.mjs"

export default { id: "missions.terminal.fixture", effect: Effect.fn(function* (ctx: any) {
  const scope = yield* Effect.scope
  yield* ctx.session.hook("http.request", (event: any) => Effect.sync(() => {
    event.request.headers.set("x-fixture-kind", event.kind)
    event.request.headers.set("x-fixture-session", event.sessionID)
  }))
  yield* ctx.rpc.register(definition, {
    read: (input: { sessionID: string; messageID?: string }) => Effect.gen(function* () {
      const observer = yield* acquireNativePassageObservation()
      return yield* Effect.promise(() => observer.session(input.sessionID, input.messageID))
    }),
    waits: (input: { sessionIDs: string[] }) => Effect.gen(function* () {
      const observer = yield* acquireNativePassageObservation()
      return { blocked: yield* Effect.promise(() => observer.requests(input.sessionIDs)) }
    }),
    // The standalone isolated server deliberately holds recovery here. The native
    // Session.resume runs only after the test has observed the old inactive claim.
    resume: (input: { sessionID: string }) => Effect.gen(function* () {
      const sessions = yield* Context.Service<never, { resume(id: string): Effect.Effect<void, unknown> }>("@opencode/Session")
      yield* Effect.forkIn(sessions.resume(input.sessionID).pipe(Effect.ignore), scope)
      return { resumed: true }
    }),
  })
}) }
