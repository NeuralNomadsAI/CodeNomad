import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { browserHostCapabilities, nativeBrowserHost, onNativeBrowserOpen, physicalBrowserBounds, selectBrowserOpenOwner } from "./browser.ts"

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

  it("routes duplicate session owners through the active instance", () => {
    const owners = [{ id: "first" }, { id: "active" }, { id: "third" }]
    assert.equal(selectBrowserOpenOwner(owners, "active"), owners[1])
  })

  it("uses a sole owner and rejects unresolved duplicate owners", () => {
    const only = { id: "only" }
    assert.equal(selectBrowserOpenOwner([only], undefined), only)
    assert.equal(selectBrowserOpenOwner([{ id: "first" }, { id: "second" }], undefined), undefined)
    assert.equal(selectBrowserOpenOwner([{ id: "first" }, { id: "second" }], "missing"), undefined)
  })
})
