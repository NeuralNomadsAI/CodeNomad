import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { runNativeFixture, fixtureChildState, observeFixtureReload } from "./native-fixture-diagnostics.mjs"
import { channel } from "node:diagnostics_channel"

for (const mode of ["complete", "early-zero", "early-seven", "throw", "unsettled-import"]) {
  test(`native runner retains status, stage and output for ${mode}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "native-diagnostics-test-"))
    try {
      const fixture = path.join(directory, "fixture with spaces")
      await mkdir(fixture)
      const script = path.join(directory, "child with spaces.mjs")
      await writeFile(script, `
        import { createNativeFixtureReporter } from ${JSON.stringify(new URL("./native-fixture-diagnostics.mjs", import.meta.url).href)};
        const reporter = createNativeFixtureReporter(process.argv[2], () => 'isolated server output');
        console.log(JSON.stringify(process.argv.slice(3)));
        console.error('isolated stderr');
        reporter.stage('ui-import-vite');
        if (${JSON.stringify(mode)} === 'early-zero') process.exit(0);
        if (${JSON.stringify(mode)} === 'early-seven') process.exit(7);
        if (${JSON.stringify(mode)} === 'throw') throw new Error('original diagnostic failure');
        if (${JSON.stringify(mode)} === 'unsettled-import') await new Promise(() => {});
        reporter.complete();
      `)
      const args = ['C:\\Program Files\\native.exe', 'Unicode-é-漢', '"quoted"']
      const result = await runNativeFixture(script, [fixture, ...args], { directory })
      assert.equal(result.exitCode, { complete: 0, "early-zero": 1, "early-seven": 7, throw: 1, "unsettled-import": 13 }[mode])
      assert.equal(result.completed, mode === "complete")
      assert.match(await readFile(path.join(result.root, "stdout.log"), "utf8"), new RegExp(JSON.stringify(args).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      assert.match(await readFile(path.join(result.root, "stderr.log"), "utf8"), /isolated stderr/)
      assert.equal(await readFile(path.join(fixture, "server.log"), "utf8"), "isolated server output")
      const records = (await readFile(path.join(result.root, "child.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
      assert(records.some(record => record.stage === "ui-import-vite"))
      if (mode === "throw") assert.match(records.find(record => record.event === "uncaught-error").error, /original diagnostic failure/)
      if (mode !== "complete") assert(records.some(record => record.event === "exit"))
      assert.equal(JSON.parse(await readFile(path.join(result.root, "result.json"), "utf8")).code, result.code)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}

test("failure before fixture creation is captured instead of reported as success", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-diagnostics-missing-"))
  try {
    const result = await runNativeFixture(path.join(directory, "missing.mjs"), [], { directory })
    assert.equal(result.completed, false)
    assert.notEqual(result.exitCode, 0)
    assert.match(await readFile(path.join(result.root, "stderr.log"), "utf8"), /MODULE_NOT_FOUND/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("private reload diagnostics filter, bound and redact transport events before owner cleanup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-reload-diagnostics-"))
  const origin = "http://127.0.0.1:1", request = { origin, method: "POST", path: "/api/location/reload" }
  Object.defineProperty(request, "headers", { get() { throw new Error("Must not read secret headers") } })
  const publish = (name, data = {}) => channel(`undici:${name}`).publish({ request, ...data })
  const success = observeFixtureReload(origin)
  let failed
  try {
    for (const foreign of [{ ...request, origin: "http://127.0.0.1:2" }, { ...request, method: "GET" },
      { ...request, path: "/api/location/reload?token=secret" }, { ...request, path: "/api/rpc/private/method" }]) {
      publish("request:create", { request: foreign })
    }
    assert.deepEqual(success.diagnostics.events, [])
    publish("request:create")
    publish("client:sendHeaders", { headers: "authorization: secret", socket: { secret: true } })
    publish("request:bodySent")
    publish("request:headers", { response: { statusCode: 204, headers: ["secret"] } })
    success.stop()
    assert.deepEqual(success.diagnostics.events.map(value => value.event), ["scheduled", "headers-sending", "emitted", "response"])
    assert.equal(success.diagnostics.events.at(-1).status, 204)
    publish("request:create")
    assert.equal(success.diagnostics.events.length, 4, "Settled observers unsubscribe")

    failed = observeFixtureReload(origin)
    const reset = Object.assign(new Error("secret reset details"), { code: "ECONNRESET" })
    const error = Object.assign(new Error("secret client details", { cause: new TypeError("secret fetch details", { cause: reset }) }), { reason: "Transport" })
    publish("request:create")
    publish("client:sendHeaders")
    publish("request:error", { error: reset })
    failed.stop(error)
    const child = { pid: 123, exitCode: null, signalCode: null, killed: false }
    const diagnostic = { reload: failed.diagnostics, beforeCleanup: fixtureChildState(child) }
    Object.assign(child, { signalCode: "SIGTERM", killed: true }) // Owner stop follows the captured state.
    const artifact = path.join(directory, "opencode", "missions-native-injected", "reload-diagnostics.json")
    await mkdir(path.dirname(artifact), { recursive: true })
    await writeFile(artifact, JSON.stringify(diagnostic))
    const saved = JSON.parse(await readFile(artifact, "utf8"))
    assert.deepEqual(saved.reload.events.map(value => value.event), ["scheduled", "headers-sending", "error"])
    assert.deepEqual(saved.reload.settled.causes, [{ name: "Error", reason: "Transport" }, { name: "TypeError" }, { name: "Error", code: "ECONNRESET" }])
    assert.deepEqual([saved.beforeCleanup.exitCode, saved.beforeCleanup.signalCode, saved.beforeCleanup.killed], [null, null, false])
    assert(!JSON.stringify([success.diagnostics, saved]).includes("secret"))
    for (const event of saved.reload.events) assert(Number.isFinite(event.durationMs) && Number.isFinite(Date.parse(event.at)))
    publish("request:create")
    assert.equal(failed.diagnostics.events.length, 3, "Failure unsubscribes without a second dispatch")

    const bounded = observeFixtureReload(origin)
    try { for (let index = 0; index < 40; index++) publish("request:create") }
    finally { bounded.stop() }
    assert.deepEqual([bounded.diagnostics.events.length, bounded.diagnostics.dropped], [32, 8])
    const fixture = (await readFile(new URL("./test-missions-native.mjs", import.meta.url), "utf8")).split("\n} finally {").at(-1)
    const capture = fixture.indexOf("receipt.beforeCleanup =")
    assert(capture >= 0)
    for (const cleanup of ["await removeBridge", "await stopFixtureChild"]) assert(fixture.indexOf(cleanup) > capture)
  } finally {
    success.stop(); failed?.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
