import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect } from "effect"
import { readNativeScheduleFlag } from "./native-schedule-flag"

test("native flag reader uses the acquired resolver and classifies only its bounded non-secret result", async () => {
  const location = { directory: "/fixture", project: { id: "project", canonical: "/fixture" } }
  let entries: any[] = [], state = { enabled: false, source: "default" }, closed = false
  const read = () => Effect.runPromise(readNativeScheduleFlag({ location } as any).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed(entries) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Flag"), { resolve: (input: unknown) => {
      assert.equal(input, entries); return { schedules: state, unrelated: { secret: "private" } }
    } }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => closed }),
  ))
  for (const enabled of [true, false]) {
    state = { enabled, source: "default" }
    assert.deepEqual(await read(), { enabled, provenance: "channel-default" })
    entries = [{ type: "document", info: { experimental: { schedules: !enabled } } }]
    state = { enabled, source: "env" }
    assert.deepEqual(await read(), { enabled, provenance: "environment" })
    state.source = "config"
    assert.deepEqual(await read(), { enabled, provenance: "experimental-block" })
  }
  entries = [{ type: "document", info: { experimental: { all_flags: true } } },
    { type: "document", info: { experimental: {} } }]
  state = { enabled: true, source: "config" }
  assert.deepEqual(await read(), { enabled: true, provenance: "all-flags" })
  state.source = "unknown"; await assert.rejects(read(), /resolution unavailable/)
  state.source = "config"; entries = new Array(257).fill({ type: "directory", path: "/fixture" })
  await assert.rejects(read(), /configuration incomplete/)
  entries = []; closed = true; await assert.rejects(read(), /Location retired/)
})
