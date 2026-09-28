import assert from "node:assert/strict"
import { it } from "node:test"
import { createInstanceFetch } from "./sdk-manager"

it("reserves foreground capacity while different workspaces queue secondary reads", async () => {
  const original = globalThis.fetch
  const pending: Array<() => void> = []
  const dispatched: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    dispatched.push(url)
    if (/\/project$|\/session\/active$/.test(url)) await new Promise<void>(resolve => pending.push(resolve))
    return Response.json({ data: [] })
  }
  const first = createInstanceFetch("http://localhost/workspaces/first/instance/")
  const second = createInstanceFetch("http://localhost/workspaces/second/instance/")
  try {
    const scans = [first("http://localhost/workspaces/first/instance/api/project"), second("http://localhost/workspaces/second/instance/api/session/active")]
    const controller = new AbortController()
    const cancelled = assert.rejects(first("http://localhost/workspaces/first/instance/api/project", { signal: controller.signal }), /Abort/)
    controller.abort()
    const trailing = second("http://localhost/workspaces/second/instance/api/project")
    await first("http://localhost/workspaces/first/instance/api/session/selected/message?limit=200&order=desc")
    const model = first("http://localhost/workspaces/first/instance/api/model")
    assert.equal(dispatched.length, 3)
    assert.ok(dispatched.some(url => /selected\/message/.test(url)))
    assert.ok(!dispatched.some(url => /\/model$/.test(url)), "model catalogues share the secondary budget")
    pending[0]()
    await scans[0]
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(dispatched.length, 4)
    pending[1]()
    pending[2]()
    await Promise.all([...scans, trailing, cancelled, model])
    assert.equal(dispatched.length, 5)
    assert.ok(dispatched.some(url => /\/model$/.test(url)))
  } finally { globalThis.fetch = original }
})
