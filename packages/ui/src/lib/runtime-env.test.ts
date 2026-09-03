import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { canRestartCli, canUseNativeDialogs, isLocalTauriHost, usesClientState, type RuntimeEnvironment } from "./runtime-env.ts"

const environment = (host: RuntimeEnvironment["host"], windowContext: RuntimeEnvironment["windowContext"]) => ({
  host,
  windowContext,
})

describe("isLocalTauriHost", () => {
  it("enables native-only features in the local Tauri window", () => {
    assert.equal(isLocalTauriHost(environment("tauri", "local")), true)
  })

  it("keeps native-only features disabled in non-local Tauri contexts", () => {
    assert.equal(isLocalTauriHost(environment("tauri", "remote")), false)
  })

  it("does not classify web or Electron windows as local Tauri", () => {
    assert.equal(isLocalTauriHost(environment("web", "remote")), false)
    assert.equal(isLocalTauriHost(environment("electron", "local")), false)
  })
})

describe("usesClientState", () => {
  it("keeps the Preferences renderer outside client-state authority", () => {
    assert.equal(usesClientState(environment("electron", "preferences")), false)
    assert.equal(usesClientState(environment("tauri", "preferences")), false)
    assert.equal(usesClientState(environment("electron", "local")), true)
    assert.equal(usesClientState(environment("web", "remote")), true)
  })
})

describe("Preferences native capabilities", () => {
  it("keeps shared settings capabilities available without client-state authority", () => {
    const previousWindow = globalThis.window
    Object.assign(globalThis, {
      window: {
        __CODENOMAD_RUNTIME_HOST__: "electron",
        __CODENOMAD_WINDOW_CONTEXT__: "preferences",
        electronAPI: {},
      },
    })
    try {
      assert.equal(canUseNativeDialogs(), true)
      assert.equal(canRestartCli(), true)
    } finally {
      Object.assign(globalThis, { window: previousWindow })
    }
  })
})
