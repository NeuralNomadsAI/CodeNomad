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
      assert.equal(input, entries); return { automations: state, unrelated: { secret: "private" } }
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

test("runtimes with the top-level setting keep a document's legacy OFF and default to on", async t => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), path = await import("node:path")
  const directory = await mkdtemp(path.join(tmpdir(), "codenomad-automations-")), legacy = path.join(directory, "global.jsonc"), project = path.join(directory, "project.json")
  t.after(() => rm(directory, { recursive: true, force: true }))
  // The legacy block, as saved for 2.3.2 and dropped from 2.4.0's normalized entries.
  await writeFile(legacy, '{\n  // saved before the upgrade\n  "experimental": { "automations": false, "todo": true },\n}\n')
  await writeFile(project, "{}")
  const location = { directory, project: { id: "project", canonical: directory } }
  let entries: any[] = []
  const read = () => Effect.runPromise(readNativeScheduleFlag({ location } as any).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed(entries) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Flag"), { resolve: () => ({ todo: { enabled: true, source: "config" } }) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => false }),
  ))
  assert.deepEqual(await read(), { enabled: true, provenance: "channel-default" })
  entries = [{ type: "document", path: legacy, info: { experimental: { todo: true } } }, { type: "document", path: project, info: {} }]
  assert.deepEqual(await read(), { enabled: false, provenance: "experimental-block", path: legacy }, "no silent reactivation after the upgrade")
  entries[1].info = { automations: true }
  assert.deepEqual(await read(), { enabled: true, provenance: "automations-setting", path: project }, "a higher top-level choice wins")
  entries = [{ type: "document", path: project, info: { automations: true } }, { type: "document", path: legacy, info: { experimental: { todo: true } } }]
  assert.deepEqual(await read(), { enabled: false, provenance: "experimental-block", path: legacy }, "a higher legacy OFF wins")
  entries = [{ type: "document", info: { automations: false } }]
  assert.deepEqual(await read(), { enabled: false, provenance: "automations-setting" })
})