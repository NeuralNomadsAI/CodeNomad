import assert from "node:assert/strict"
import test from "node:test"

import { shouldRetryPreferredPort } from "../http-server"

test("automatic listeners retry Windows reserved ports without masking explicit failures", () => {
  assert.equal(shouldRetryPreferredPort({ code: "EADDRINUSE" }, true, "linux"), true)
  assert.equal(shouldRetryPreferredPort({ code: "EACCES" }, true, "win32"), true)
  assert.equal(shouldRetryPreferredPort({ code: "EACCES" }, true, "linux"), false)
  assert.equal(shouldRetryPreferredPort({ code: "EACCES" }, false, "win32"), false)
})
