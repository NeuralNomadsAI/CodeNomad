import assert from "node:assert/strict"
import test from "node:test"
import type { Endpoint } from "@opencode/client/service"
import { isBelowOpenCodeMinimum, UnsupportedOpenCodeError, MINIMUM_OPENCODE_VERSION, RECOMMENDED_OPENCODE_VERSION } from "./runtime-support"
import { rememberRuntime } from "./compatibility/runtime"
import { OpenCodeSharedService } from "../workspaces/opencode-service"

test("native timestamp minimum is distinct from recommendation and unfamiliar version labels", () => {
  assert.equal(MINIMUM_OPENCODE_VERSION, "2.0.7")
  assert.equal(RECOMMENDED_OPENCODE_VERSION, "2.0.11")
  for (const version of ["2.0.7", "2.0.8", "2.0.9", "2.0.10", "2.0.11", "2.0.12", "2.1.0", "2.0.11-dev.1", "3.0.0", "custom-build"]) {
    assert.equal(isBelowOpenCodeMinimum(version), false, version)
  }
  for (const version of ["2.0.0", "2.0.4", "2.0.5", "2.0.6", "0.0.0-beta-19507"]) assert.equal(isBelowOpenCodeMinimum(version), true, version)
})

test("refuses old authenticated daemons before client calls or plugin preparation", async () => {
  let constructed = 0, prepared = 0
  const endpoint: Endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.0.6", pid: 1, discovery: "info" })
  const service = new OpenCodeSharedService({ headers: () => ({ authorization: "fixture" }), makeClient: () => { constructed++; throw new Error("not reached") } })
  const options = { kind: "lifecycle" as const, identity: "fixture",
    lifecycle: { discover: async () => endpoint, ensure: async () => { throw new Error("must not start") } },
    prepareDesktopPlugins: async () => { prepared++; return true },
  }
  await assert.rejects(service.client(options), (error: unknown) => error instanceof UnsupportedOpenCodeError
    && error.actualVersion === "2.0.6" && error.minimumVersion === "2.0.7" && error.reason === "step_timestamp")
  assert.equal(constructed, 0)
  assert.equal(prepared, 0)
})
