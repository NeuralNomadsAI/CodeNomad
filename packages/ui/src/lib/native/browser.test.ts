import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { nativeBrowserHost, physicalBrowserBounds } from "./browser.ts"

describe("native browser adapter", () => {
  it("enables Tauri only for local Windows windows", () => {
    assert.equal(nativeBrowserHost({ host: "tauri", windowContext: "local" }, "Windows NT"), "tauri")
    assert.equal(nativeBrowserHost({ host: "tauri", windowContext: "local" }, "Linux"), undefined)
    assert.equal(nativeBrowserHost({ host: "tauri", windowContext: "remote" }, "Windows NT"), undefined)
    assert.equal(nativeBrowserHost({ host: "electron", windowContext: "local" }, "Linux"), "electron")
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
