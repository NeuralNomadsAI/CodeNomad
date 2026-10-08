import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Exit, Fiber, Option, RcMap, Schema, Scope } from "effect"
import { cancelNativeRecurrenceClock, readNativeRecurrenceClock, startNativeRecurrenceClock } from "./native-service-clock"

const jobTag = Context.Service<never, unknown>("@opencode/Job")
const mapTag = Context.Service<never, unknown>("@opencode/example/LocationServiceMap")
const sessionTag = Context.Service<never, unknown>("@opencode/Session")
const locationTag = Context.Service<never, Location.Info>("@opencode/Location")

test("a daemon Job reacquires its exact Location after the originating graph is evicted", async () => {
  const directory = path.resolve("recurrence-service-clock-fixture"), workspaceID = "wrk_00000000000000000000000000"
  const ref = Schema.decodeUnknownSync(Location.Ref)({ directory, workspaceID })
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, workspaceID,
    project: { id: "p1", directory, canonical: directory } })
  const scope = await Effect.runPromise(Scope.make())
  try {
    let loads = 0, dueCalls = 0
    const map = await Effect.runPromise(RcMap.make({ idleTimeToLive: Infinity,
      lookup: (key: Location.Ref) => Effect.sync(() => {
        assert.equal(key.workspaceID, workspaceID)
        loads++
        return Context.make(locationTag, location)
      }),
    }).pipe(Effect.provideService(Scope.Scope, scope)))
    const locations = { rcMap: map, contextEffect: (key: Location.Ref) => RcMap.get(map, key),
      contextEffectOption: (key: Location.Ref) => RcMap.getOption(map, key) }
    const jobs = new Map<string, { info: { id: string; type: string; status: string; metadata: Record<string, unknown> };
      run: Effect.Effect<string, unknown>; fiber?: Fiber.Fiber<string, unknown> }>()
    const job = {
      get: (id: string) => Effect.succeed(jobs.get(id)?.info),
      start: (input: { id: string; type: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }) => Effect.sync(() => {
        const existing = jobs.get(input.id)
        if (existing?.info.status === "running") return existing.info
        const info = { id: input.id, type: input.type, status: "running", metadata: input.metadata }
        jobs.set(input.id, { info, run: input.run })
        return info
      }),
      cancel: (id: string) => Effect.gen(function* () {
        const entry = jobs.get(id)
        if (entry?.fiber) yield* Fiber.interrupt(entry.fiber)
        if (entry) entry.info.status = "cancelled"
        return entry?.info
      }),
    }
    const app = Context.make(jobTag, job).pipe(Context.add(mapTag, locations), Context.add(sessionTag, {}),
      Context.add(locationTag, location))
    const input = { directory, workspaceID, projectID: "p1", projectCanonical: directory, scheduleID: "rec_one",
      profileID: "profile-one", executionHost: "native", epoch: 1 }
    const due = async (_graph: Context.Context<never>, current: () => true) => {
      dueCalls++
      assert.equal(current(), true)
      return "unknown" as const
    }

    await Effect.runPromise(Effect.scoped(RcMap.get(map, ref)))
    await Effect.runPromise(RcMap.invalidate(map, ref))
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock(input, due))
    assert.equal(await Effect.runPromise([...jobs.values()][0]!.run), "unknown")
    assert.equal(loads, 2)
    assert.equal(dueCalls, 1)
    const read = () => Effect.runPromiseWith(app)(readNativeRecurrenceClock(input))
    assert.equal(await read(), true)
    await Effect.runPromise(RcMap.invalidate(map, ref))
    assert.equal(await read(), undefined, "Job.get remains running after eviction; Location claim is uncertain")
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock(input, due))
    assert.equal(jobs.size, 1, "one native Job per signed epoch")
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock({ ...input, epoch: 2 }, due))
    assert.equal(jobs.size, 2, "a late Pause must not cancel a new Resume epoch")
    await Effect.runPromiseWith(app)(cancelNativeRecurrenceClock(input))
    assert.equal([...jobs.values()][0]!.info.status, "cancelled")
    assert.equal([...jobs.values()][1]!.info.status, "running")
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock({ ...input, epoch: 3 },
      async (_graph, current) => {
        await Effect.runPromise(RcMap.invalidate(map, ref))
        current()
        return "accepted" as const
      }))
    await assert.rejects(Effect.runPromise([...jobs.values()][2]!.run),
      (error: unknown) => error instanceof Error && (error as Error & { cause?: Error }).cause?.message === "Recurrence Location replaced")

    let entered!: () => void, cancelled = false
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const latest = { ...input, epoch: 4 }
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock(latest, (_graph, current, signal) =>
      new Promise<"pending">(resolve => {
        entered()
        signal.addEventListener("abort", () => {
          cancelled = true
          assert.equal(current(), true, "cancelled dispatch retains the borrowed graph for bounded positive receipt draining")
          resolve("pending")
        }, { once: true })
      })))
    const last = [...jobs.values()][3]!
    const fiber = Effect.runFork(last.run)
    last.fiber = fiber
    await waiting
    await Effect.runPromiseWith(app)(cancelNativeRecurrenceClock(latest))
    assert.equal(cancelled, true, "native Job interruption aborts in-flight admission without a bundle-local registry")
    assert(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber))))

    let ticked!: () => void
    const tick = new Promise<void>(resolve => { ticked = resolve })
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock({ ...input, epoch: 5 }, async () => {
      ticked()
      return "not-due"
    }))
    const sleeper = Effect.runFork([...jobs.values()][4]!.run)
    await tick
    await Effect.runPromise(Fiber.interrupt(sleeper))
    assert(Exit.isFailure(await Effect.runPromise(Fiber.await(sleeper))),
      "ordinary not-due passages wait interruptibly instead of pinning the origin Scope")

    let passagePending!: () => void
    const reserved = new Promise<void>(resolve => { passagePending = resolve })
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock({ ...input, epoch: 6 }, async () => {
      passagePending()
      return "pending"
    }))
    const nextDay = Effect.runFork([...jobs.values()][5]!.run)
    await reserved
    assert(Option.isNone(await Effect.runPromise(Fiber.await(nextDay).pipe(Effect.timeoutOption(20)))),
      "an accepted pending passage keeps tomorrow's service clock, without a second admission")
    await Effect.runPromise(Fiber.interrupt(nextDay))
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})
