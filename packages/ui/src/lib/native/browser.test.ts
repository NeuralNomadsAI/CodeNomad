import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { nativeBrowserHost, physicalBrowserBounds, selectBrowserOpenOwner } from "./browser.ts"

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
