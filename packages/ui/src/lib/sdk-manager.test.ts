import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { buildInstanceBaseUrl, createInstanceFetch, sdkManager } from "./sdk-manager.ts"
import { tGlobal } from "./i18n"

afterEach(() => {
  sdkManager.destroyClientsForInstance("instance-a")
  sdkManager.destroyClientsForInstance("instance-b")
})

describe("SDKManager", () => {
  it("keeps saved-session reads and mutations dispatchable while cross-project catalogues are stalled", async () => {
    const original = globalThis.fetch
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dispatched: string[] = []
    const requests: Promise<Response>[] = []
    try {
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input)).pathname
        dispatched.push(`${init?.method ?? "GET"} ${path}`)
        if (!path.includes("/session/saved") && init?.method !== "POST") await gate
        return Response.json({})
      }
      const first = createInstanceFetch("https://codenomad.test/workspaces/first/instance/")
      const second = createInstanceFetch("https://codenomad.test/workspaces/second/instance/")
      for (const path of ["agent", "provider", "model", "model/default", "command", "location", "shell", "session/active"]) {
        requests.push(first(`http://localhost/api/${path}`), second(`http://localhost/api/${path}`))
      }
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(dispatched.length, 2, "all projects must share the secondary connection budget")
      const abort = new AbortController()
      const cancelled = first("http://localhost/api/model", { signal: abort.signal })
      const rejected = assert.rejects(cancelled, { name: "AbortError" })
      abort.abort()
      await rejected
      await first("http://localhost/api/session/saved")
      await first("http://localhost/api/session/saved/message?limit=200")
      await first("http://localhost/api/agent", { method: "POST" })
      assert.equal(dispatched.length, 5, "foreground reads and writes must bypass stalled catalogues")
      release()
      await Promise.all(requests)
      assert.equal(dispatched.length, 19, "cancelled queued reads must never dispatch")
    } finally {
      release()
      await Promise.allSettled(requests)
      globalThis.fetch = original
    }
  })
  it("reports environment admission failures without exposing an upstream error body", async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = async () => Response.json({ error: "session_environment_failed" }, { status: 502 })
      const fetcher = createInstanceFetch("https://codenomad.test/workspaces/w/instance/")
      await assert.rejects(fetcher("http://localhost/api/session/s/prompt", { method: "POST" }), {
        message: tGlobal("envEditor.applyFailed"),
      })
      globalThis.fetch = async () => Response.json({ error: "other" }, { status: 502 })
      assert.deepEqual(await (await fetcher("http://localhost/api/session/s/prompt", { method: "POST" })).json(), { error: "other" })
    } finally { globalThis.fetch = original }
  })
  it("normalizes instance proxy URLs", () => {
    assert.equal(
      buildInstanceBaseUrl("workspaces//instance-a/instance///", "https://codenomad.test///"),
      "https://codenomad.test/workspaces/instance-a/instance/",
    )
  })

  it("caches clients by instance and normalized proxy path", () => {
    const first = sdkManager.createClient("instance-a", "/workspaces/instance-a/instance")
    const cached = sdkManager.createClient("instance-a", "workspaces//instance-a/instance/")
    const other = sdkManager.createClient("instance-b", "/workspaces/instance-a/instance")

    assert.strictEqual(cached, first)
    assert.notStrictEqual(other, first)
  })
})
