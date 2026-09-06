import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"
import { probeBinaryVersion, probeOpenCodeBinary } from "../spawn"
import { OPENCODE_V2_REQUIRED_ERROR_CODE } from "../../api-types"
import { binaryProbeFixture, legacyHelp, serviceHelp } from "./binary-probe-fixture"

describe("bounded read-only binary validation", () => {
  it("keeps the event loop available during real slow version and help subprocesses", async () => {
    const fixture = binaryProbeFixture({ delayMs: 250 })
    try {
      let completed = false
      const result = probeOpenCodeBinary(fixture.binary).then((value) => { completed = true; return value })
      await delay(50)
      assert.equal(completed, false, "the probes must not block timers or other requests")
      assert.deepEqual(await result, { valid: true })
      assert.deepEqual(fixture.calls(), [["--version"], ["service", "--help"]])
    } finally {
      fixture.dispose()
    }
  })

  it("rejects real legacy shims on stdout/stderr with both exit-zero and exit-one help", async () => {
    for (const stderr of [false, true]) for (const helpExit of [0, 1]) {
      const fixture = binaryProbeFixture({ help: legacyHelp, stderr, helpExit })
      try {
        assert.deepEqual(await probeOpenCodeBinary(fixture.binary), { valid: false, errorCode: OPENCODE_V2_REQUIRED_ERROR_CODE })
        assert.deepEqual(fixture.calls(), [["--version"], ["service", "--help"]])
      } finally {
        fixture.dispose()
      }
    }
  })

  it("uses finite bounds for both probes without constraining custom version labels", async () => {
    for (const version of ["custom-build\n", "opencode2 v0.0.0-beta-19192\n", "99.1.0\n", ""]) {
      const calls: string[][] = []
      const result = await probeOpenCodeBinary(process.execPath, async (spec, timeout) => {
        assert.equal(timeout, 5_000)
        calls.push(spec.args)
        return { status: 0, stderr: spec.args[0] === "--version" ? version : serviceHelp }
      })
      assert.equal(result.valid, true)
      assert.deepEqual(calls, [["--version"], ["service", "--help"]])
    }
  })

  it("preserves missing-file, permission, timeout, output-limit and nonzero diagnostics", async () => {
    assert.deepEqual(await probeOpenCodeBinary(""), { valid: false, error: "Missing binary path" })
    for (const stage of ["--version", "service"]) for (const code of ["ENOENT", "EACCES", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
      const calls: string[][] = []
      const result = await probeOpenCodeBinary(process.execPath, (spec) => {
        calls.push(spec.args)
        return spec.args[0] === stage
          ? { status: null, error: new Error(code), stdout: legacyHelp }
          : { status: 0, stdout: "2.0.0\n" }
      })
      assert.equal(result.valid, false)
      assert.equal(result.error, code)
      assert.equal(result.errorCode, undefined, "partial help must not mask an execution error")
      assert.equal(calls.length, stage === "--version" ? 1 : 2)
    }
    const failed = await probeOpenCodeBinary(process.execPath, (spec) => spec.args[0] === "--version"
      ? { status: 0, stdout: "2.0.0\n" } : { status: 7, stderr: "Permission denied" })
    assert.equal(failed.valid, false)
    assert.match(failed.error ?? "", /code 7: Permission denied/)
    assert.equal(failed.errorCode, undefined)
    const rejected = await probeOpenCodeBinary(process.execPath, async () => { throw new Error("launch failed") })
    assert.deepEqual(rejected, { valid: false, error: "launch failed" })
  })

  it("retains the version-only updater probe contract without probing service", () => {
    const calls: string[][] = []
    const result = probeBinaryVersion(process.execPath, (spec) => {
      calls.push(spec.args)
      return { status: 0, stderr: "1.18.25\n" }
    })
    assert.deepEqual(result, { valid: true, version: "1.18.25", reported: "1.18.25" })
    assert.deepEqual(calls, [["--version"]])
  })
})
