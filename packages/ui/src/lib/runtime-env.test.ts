import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isLocalTauriHost, type RuntimeEnvironment } from "./runtime-env.ts"

const environment = (host: RuntimeEnvironment["host"], windowContext: RuntimeEnvironment["windowContext"]) => ({
  host,
  windowContext,
})

describe("isLocalTauriHost", () => {
  it("enables native-only features in the local Tauri window", () => {
    assert.equal(isLocalTauriHost(environment("tauri", "local")), true)
  })

  it("keeps native-only features disabled in remote Tauri windows", () => {
    assert.equal(isLocalTauriHost(environment("tauri", "remote")), false)
  })

  it("does not classify web or Electron windows as local Tauri", () => {
    assert.equal(isLocalTauriHost(environment("web", "remote")), false)
    assert.equal(isLocalTauriHost(environment("electron", "local")), false)
  })
})
