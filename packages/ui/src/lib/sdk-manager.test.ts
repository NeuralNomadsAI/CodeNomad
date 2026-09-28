import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { OpenCode } from "@opencode/client"

import { buildInstanceBaseUrl, createInstanceFetch, sdkManager } from "./sdk-manager.ts"
import { tGlobal } from "./i18n"
import { getOpencodeErrorMessage } from "./opencode-api"

afterEach(() => {
  sdkManager.destroyClientsForInstance("instance-a")
  sdkManager.destroyClientsForInstance("instance-b")
})

describe("SDKManager", () => {
  it("keeps detailed client failures actionable without replaying a mutation", async () => {
    const original = globalThis.fetch
    const baseUrl = buildInstanceBaseUrl("/workspaces/first/instance", "https://codenomad.test/tenant")
    const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
    const cases = [
      { response: () => new Response("private upstream body", { status: 500 }), reason: "UnexpectedStatus",
        message: "UnexpectedStatus: 500", display: "Unexpected status 500" },
      { response: () => new Response("private HTML", { headers: { "content-type": "text/html" } }), reason: "UnsupportedContentType",
        message: "UnsupportedContentType: text/html", display: "UnsupportedContentType: text/html" },
      { response: () => { throw new TypeError("Fixture connection refused") }, reason: "Transport",
        message: "Transport: Fixture connection refused", display: "Fixture connection refused" },
    ]
    try {
      for (const fixture of cases) {
        let calls = 0
        globalThis.fetch = async (input, init) => {
          calls++
          assert.equal(String(input), `${baseUrl}api/session/owned/prompt`)
          assert.equal(init?.method, "POST")
          assert.equal(init?.credentials, "include")
          return fixture.response()
        }
        await assert.rejects(client.session.prompt({ sessionID: "owned", text: "fixture" }), error => {
          assert.ok(error instanceof Error)
          assert.equal((error as Error & { reason: string }).reason, fixture.reason)
          assert.equal(error.message, fixture.message)
          assert.equal(getOpencodeErrorMessage(error, "fallback"), fixture.display)
          return true
        })
        assert.equal(calls, 1)
      }
    } finally { globalThis.fetch = original }
  })
  it("preserves the generated client's proxy prefix exactly once for instructions and declared errors", async () => {
    const original = globalThis.fetch
    const requests: string[] = []
    try {
      globalThis.fetch = async (input, init) => {
        requests.push(`${init?.method} ${String(input)}`)
        if (init?.method === "DELETE") return new Response(null, { status: 204 })
        return Response.json({ _tag: "InvalidRequestError", message: "fixture rejection", kind: "fixture" }, { status: 400 })
      }
      const baseUrl = buildInstanceBaseUrl("/workspaces/first/instance", "https://codenomad.test/tenant")
      const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
      await client.session.instructions.entry.remove({ sessionID: "owned", key: "codenomad.voice-mode" })
      await assert.rejects(client.session.instructions.entry.put({ sessionID: "owned", key: "codenomad.session-placement", value: "fixture" }), error => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, "fixture rejection")
        assert.equal((error as Error & { _tag: string })._tag, "InvalidRequestError")
        return true
      })
      assert.deepEqual(requests, [
        `DELETE ${baseUrl}api/experimental/session/owned/instructions/entries/codenomad.voice-mode`,
        `PUT ${baseUrl}api/experimental/session/owned/instructions/entries/codenomad.session-placement`,
      ])
    } finally { globalThis.fetch = original }
  })
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
        requests.push(first(`https://codenomad.test/workspaces/first/instance/api/${path}`), second(`https://codenomad.test/workspaces/second/instance/api/${path}`))
      }
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(dispatched.length, 2, "all projects must share the secondary connection budget")
      const abort = new AbortController()
      const cancelled = first("https://codenomad.test/workspaces/first/instance/api/model", { signal: abort.signal })
      const rejected = assert.rejects(cancelled, { name: "AbortError" })
      abort.abort()
      await rejected
      await first("https://codenomad.test/workspaces/first/instance/api/session/saved")
      await first("https://codenomad.test/workspaces/first/instance/api/session/saved/message?limit=200")
      await first("https://codenomad.test/workspaces/first/instance/api/agent", { method: "POST" })
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
      await assert.rejects(fetcher("https://codenomad.test/workspaces/w/instance/api/session/s/prompt", { method: "POST" }), {
        message: tGlobal("envEditor.applyFailed"),
      })
      globalThis.fetch = async () => Response.json({ error: "other" }, { status: 502 })
      assert.deepEqual(await (await fetcher("https://codenomad.test/workspaces/w/instance/api/session/s/prompt", { method: "POST" })).json(), { error: "other" })
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
