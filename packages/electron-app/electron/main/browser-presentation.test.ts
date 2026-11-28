import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import { isPrivatePreviewUrl } from "./browser-presentation"

const cases = JSON.parse(readFileSync(new URL("../../../tauri-app/tests/private-preview-url-cases.json", import.meta.url), "utf8")) as { url: string; private: boolean }[]
const program = readFileSync(new URL("../../../ui/src/lib/native/remote-preview-guards.cjs", import.meta.url), "utf8")

test("native preview identity matches only the parsed HTTP(S) content host", () => {
  for (const entry of cases) assert.equal(isPrivatePreviewUrl(entry.url), entry.private, entry.url)
})

test("the fixed preload guard ignores private-looking paths, queries and foreign hosts", () => {
  for (const entry of cases) {
    const window = { print() {}, addEventListener() {} }
    class KeyboardEvent {
      get key() { return "" }
      get ctrlKey() { return false }
      get metaKey() { return false }
    }
    vm.runInNewContext(program, {
      URL, Event, KeyboardEvent, DOMException, window,
      location: { href: entry.url, ancestorOrigins: [] }, origin: "",
      document: { referrer: "" }, navigator: {},
      Navigator: class {}, Document: class {},
    })
    assert.equal(Object.getOwnPropertyDescriptor(window, "print")?.configurable === false, entry.private, entry.url)
  }
})
