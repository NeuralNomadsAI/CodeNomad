import assert from "node:assert/strict"
import test from "node:test"
import type { Endpoint } from "@opencode/client/service"
import { isBelowOpenCodeMinimum, UnsupportedOpenCodeError, MINIMUM_OPENCODE_VERSION, RECOMMENDED_OPENCODE_VERSION } from "./runtime-support"
import { rememberRuntime } from "./compatibility/runtime"
import { OpenCodeSharedService } from "../workspaces/opencode-service"

test("native plugin runtime minimum does not become an allowlist of tested labels", () => {
  assert.equal(MINIMUM_OPENCODE_VERSION, "2.1.2")
  assert.equal(RECOMMENDED_OPENCODE_VERSION, "2.1.3")
  for (const version of ["2.1.2", "2.1.2+custom", "2.1.3", "2.2.0", "2.1.0-dev.1", "3.0.0", "custom-build"]) {
    assert.equal(isBelowOpenCodeMinimum(version), false, version)
  }
  for (const version of ["2.0.0", "2.0.7", "2.0.26", "2.0.27", "2.0.29", "2.0.32", "2.1.0", "2.1.1", "2.1.1+custom", "0.0.0-beta-19507"]) assert.equal(isBelowOpenCodeMinimum(version), true, version)
})

test("refuses old authenticated daemons before client calls or plugin preparation", async () => {
  for (const version of ["2.0.32", "2.1.0", "2.1.1"]) {
    let constructed = 0, prepared = 0
    const endpoint: Endpoint = { url: "http://127.0.0.1:4321" }
    rememberRuntime(endpoint, { version, pid: 1, discovery: "info" })
    const service = new OpenCodeSharedService({ headers: () => ({ authorization: "fixture" }), makeClient: () => { constructed++; throw new Error("not reached") } })
    const options = { kind: "lifecycle" as const, identity: "fixture",
      lifecycle: { discover: async () => endpoint, ensure: async () => { throw new Error("must not start") } },
      prepareDesktopPlugins: async () => { prepared++; return true },
    }
    await assert.rejects(service.client(options), (error: unknown) => error instanceof UnsupportedOpenCodeError
      && error.actualVersion === version && error.minimumVersion === "2.1.2" && error.reason === "native_contract"
      && /Code Mode job ordering fixed in 2.1.2/.test(error.message))
    assert.equal(constructed, 0)
    assert.equal(prepared, 0)
  }
})
