import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { runNativeFixture } from "./native-fixture-diagnostics.mjs"

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
