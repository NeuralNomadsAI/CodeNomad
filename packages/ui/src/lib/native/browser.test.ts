import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { browserHostCapabilities, nativeBrowserHost, onNativeBrowserOpen, physicalBrowserBounds } from "./browser.ts"

describe("native browser adapter", () => {
  it("subscribes to WebKit open requests with native automation available", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
    const calls: Array<{ event: string; target: unknown }> = []
    const callbacks: Array<(event: { payload: unknown }) => void> = []
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        __CODENOMAD_RUNTIME_HOST__: "tauri", __CODENOMAD_WINDOW_CONTEXT__: "local",
        __CODENOMAD_BROWSER_CAPABILITIES__: { embedding: true, history: true, emulation: true, automation: true, reason: "webkit" },
        __TAURI_INTERNALS__: {
          metadata: { currentWebview: { label: "local-target" }, currentWindow: { label: "local-target" } },
          transformCallback: (callback: (typeof callbacks)[number]) => callbacks.push(callback),
          invoke: async (command: string, args: (typeof calls)[number]) => {
            if (command === "plugin:event|listen") return calls.push(args)
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      } })
      let received: unknown
      const accept = (payload: unknown) => { received = payload }
      const unsubscribe = await onNativeBrowserOpen(accept, accept, accept)
      assert.deepEqual(calls.map(({ event, target }) => ({ event, target })), ["open-settled", "open", "discover"].map(action => ({
        event: `browser-target:${action}`, target: { kind: "Webview", label: "local-target" },
      })))
      const discovery = { workspaceIDs: ["tab"], requestID: "request" }
      callbacks[2]({ payload: discovery })
      assert.deepEqual(received, discovery)
      const payload = { sessionID: "session", url: "https://example.com/", requestID: "request", instanceId: "tab" }
      callbacks[1]({ payload })
      assert.deepEqual(received, payload)
      const settled = { sessionID: "session", requestID: "request", instanceId: "tab", committedUrl: "https://example.com/redirect" }
      callbacks[0]({ payload: settled })
      assert.deepEqual(received, settled)
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

})
