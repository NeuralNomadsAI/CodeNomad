import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildPreviewRuntimeBridge, previewStorageShim } from "./runtime-bridge"

/** An opaque-origin window: storage accessors throw like a sandboxed frame's. */
function opaqueWindow(): Record<string, unknown> {
  const window: Record<string, unknown> = {}
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, {
      configurable: true,
      get() {
        throw new Error("SecurityError")
      },
      set() {},
    })
  }
  return window
}

/** An opaque-origin document: cookie reads are empty and writes are dropped. */
function opaqueDocument(): Record<string, unknown> {
  const document: Record<string, unknown> = {}
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: () => {} })
  return document
}

const runShim = (window: Record<string, unknown>, document: Record<string, unknown>) =>
  new Function("window", "document", previewStorageShim())(window, document)

function workingStorage() {
  const jar = new Map<string, string>()
  return {
    get length() {
      return jar.size
    },
    key: (index: number) => [...jar.keys()][index] ?? null,
    getItem: (key: string) => (jar.has(String(key)) ? jar.get(String(key)) : null),
    setItem: (key: string, value: string) => void jar.set(String(key), String(value)),
    removeItem: (key: string) => void jar.delete(String(key)),
    clear: () => void jar.clear(),
  }
}

describe("previewStorageShim", () => {
  it("provides a working in-memory localStorage behind a throwing accessor", () => {
    const window = opaqueWindow()
    runShim(window, opaqueDocument())
    const storage = window.localStorage as Storage
    assert.equal(storage.getItem("token"), null)
    storage.setItem("token", "abc")
    storage.setItem("theme", "dark")
    assert.equal(storage.getItem("token"), "abc")
    assert.equal(storage.length, 2)
    assert.equal(storage.key(0), "token")
    storage.removeItem("theme")
    assert.equal(storage.getItem("theme"), null)
    storage.clear()
    assert.equal(storage.length, 0)
  })

  it("keeps localStorage and sessionStorage as independent jars", () => {
    const window = opaqueWindow()
    runShim(window, opaqueDocument())
    ;(window.localStorage as Storage).setItem("a", "1")
    assert.equal((window.sessionStorage as Storage).getItem("a"), null)
    ;(window.sessionStorage as Storage).setItem("a", "2")
    assert.equal((window.localStorage as Storage).getItem("a"), "1")
  })

  it("serves document.cookie from memory with attribute and expiry handling", () => {
    const document = opaqueDocument()
    runShim(opaqueWindow(), document)
    document.cookie = "session=xyz; Path=/"
    document.cookie = "flash=1; Max-Age=0"
    document.cookie = "stale=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    assert.equal(document.cookie, "session=xyz")
    document.cookie = "extra=2"
    assert.equal(document.cookie, "session=xyz; extra=2")
    document.cookie = "session=; Max-Age=0"
    assert.equal(document.cookie, "extra=2")
  })

  it("leaves working real storage untouched", () => {
    const window: Record<string, unknown> = {
      localStorage: workingStorage(),
      sessionStorage: workingStorage(),
    }
    const document: Record<string, unknown> = {}
    let cookieValue = ""
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => cookieValue,
      set: (value: string) => {
        if (value.includes("=") && !value.includes("Max-Age=0")) cookieValue = value.split(";")[0]
        else cookieValue = ""
      },
    })
    runShim(window, document)
    assert.equal(window.localStorage, (window as Record<string, unknown>).localStorage)
    ;(window.localStorage as Storage).setItem("kept", "yes")
    assert.equal((window.localStorage as Storage).getItem("kept"), "yes")
    document.cookie = "real=1"
    assert.equal(document.cookie, "real=1")
  })

  it("is part of the injected runtime bridge", () => {
    const bridge = buildPreviewRuntimeBridge("/previews/token/", "http://localhost:3000/")
    assert.match(bridge, /localStorage/)
    assert.match(bridge, /sessionStorage/)
    assert.match(bridge, /document\.cookie/)
  })
})
