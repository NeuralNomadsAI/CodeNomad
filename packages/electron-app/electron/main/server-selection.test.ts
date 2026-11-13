import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"
import { requireServerSelection, selectServerInWindow } from "./server-selection"

const intent = { id: "a", baseUrl: "https://a.test", skipTlsVerify: false }
test("selection rejects credentials, extra fields, malformed policy and another Preferences section", () => {
  assert.deepEqual(requireServerSelection(intent, "servers"), intent)
  for (const value of [
    { ...intent, id: "local" }, { ...intent, skipTlsVerify: "true" }, { ...intent, password: "secret" },
    { ...intent, baseUrl: "https://user:secret@a.test" }, { ...intent, baseUrl: "https://a.test/?secret=1" },
    { ...intent, ssh: { host: "-o ProxyCommand=x" } }, { ...intent, ssh: { host: "vm", password: "secret" } },
  ]) assert.throws(() => requireServerSelection(value, "servers"))
  assert.throws(() => requireServerSelection(intent, "general"))
})
test("native forwarding executes only in the exact trusted opener origin", async () => {
  const calls: unknown[] = []
  const context = { window: { location: { origin: "http://localhost:3000" }, __CODENOMAD_SELECT_SERVER__: (value: unknown) => { calls.push(value) } } }
  const target = { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => "http://localhost:3000",
    executeJavaScript: async (source: string) => vm.runInNewContext(source, context) } }
  await selectServerInWindow(target, intent, () => true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [intent])
  await assert.rejects(selectServerInWindow(undefined, intent, () => true))
  await assert.rejects(selectServerInWindow(target, intent, () => false))
  context.window.location.origin = "https://outside.test"
  await assert.rejects(selectServerInWindow(target, intent, () => true), /origin changed/)
  assert.equal(calls.length, 1)
})
