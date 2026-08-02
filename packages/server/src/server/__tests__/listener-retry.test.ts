import assert from "node:assert/strict"
import test from "node:test"

import { programHasArg } from "../../index"
import { shouldRetryPreferredPort } from "../http-server"

test("automatic listeners retry Windows reserved ports without masking explicit failures", () => {
  assert.equal(shouldRetryPreferredPort({ code: "EADDRINUSE" }, true, "linux"), true)
  assert.equal(shouldRetryPreferredPort({ code: "EACCES" }, true, "win32"), true)
  assert.equal(shouldRetryPreferredPort({ code: "EACCES" }, true, "linux"), false)
  assert.equal(shouldRetryPreferredPort({ code: "EACCES" }, false, "win32"), false)
})

test("explicit listener ports are detected in both supported CLI forms", () => {
  assert.equal(programHasArg(["--http-port", "9899"], "--http-port"), true)
  assert.equal(programHasArg(["--https-port=9898"], "--https-port"), true)
  assert.equal(programHasArg(["--http-porter=9899"], "--http-port"), false)
})
