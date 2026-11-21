import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { browserHostCapabilities, nativeBrowserHost, onNativeBrowserOpen, physicalBrowserBounds, registerTauriBrowserTarget } from "./browser.ts"

describe("native browser adapter", () => {
  it("subscribes to WebKit open requests with native automation available", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
    const calls: string[] = []
    let dispatch: (event: { payload: unknown }) => void = () => {}
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        __CODENOMAD_RUNTIME_HOST__: "tauri", __CODENOMAD_WINDOW_CONTEXT__: "local",
        __CODENOMAD_BROWSER_CAPABILITIES__: { embedding: true, history: true, emulation: true, automation: true, reason: "webkit" },
        __TAURI_INTERNALS__: {
          transformCallback: (callback: typeof dispatch) => { dispatch = callback; return 1 },
          invoke: async (command: string) => { calls.push(command); return 1 },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      } })
      let received: unknown
      const unsubscribe = await onNativeBrowserOpen(payload => { received = payload })
      assert.deepEqual(calls, ["plugin:event|listen"])
      const payload = { sessionID: "session", url: "https://example.com/", requestID: "request" }
      dispatch({ payload })
      assert.deepEqual(received, payload)
      assert.equal(browserHostCapabilities({ host: "tauri", windowContext: "local" }).automation, true)
      await unsubscribe()
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
  it("uses host-published embedding independently of history, emulation and automation", () => {
    const local = { host: "tauri", windowContext: "local" } as const
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
      assert.equal(nativeBrowserHost(local), undefined)
      for (const emulation of [false, true]) {
        window.__CODENOMAD_BROWSER_CAPABILITIES__ = { embedding: true, history: true, emulation, automation: emulation }
        assert.equal(nativeBrowserHost(local), "tauri")
        assert.equal(browserHostCapabilities(local).emulation, emulation)
      }
      assert.equal(nativeBrowserHost({ host: "tauri", windowContext: "remote" }), undefined)
      assert.equal(nativeBrowserHost({ host: "electron", windowContext: "local" }), "electron")
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("maps CSS bounds to WebView2 physical pixels", () => {
    assert.deepEqual(physicalBrowserBounds({ x: 10.2, y: 20.4, width: 100.5, height: 50.2 }, 1.5), {
      x: 15,
      y: 31,
      width: 151,
      height: 75,
    })
  })

  it("sends the calling document's nonce with Tauri registration, even if injection is pending", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
    const calls: unknown[] = []
    const renderer = Object.assign(new EventTarget(), {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => { calls.push({ command, args }); return true },
      },
    })
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: renderer })
      const payload = { sessionId: "session", registrationId: "preview", url: "https://example.com/", bounds: { x: 0, y: 0, width: 320, height: 240 } }
      const registered = registerTauriBrowserTarget(payload)
      assert.deepEqual(calls, [])
      Object.defineProperty(renderer, "__CODENOMAD_BROWSER_DOCUMENT__", { value: "own-document" })
      renderer.dispatchEvent(new Event("codenomad:browser-document"))
      assert.equal(await registered, true)
      assert.deepEqual(calls, [{
        command: "browser_target_register",
        args: { rendererDocument: "own-document", payload: { ...payload, visible: false } },
      }])
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})
