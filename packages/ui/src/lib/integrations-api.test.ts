import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { installIntegration } from "./integrations-api"
import { HttpResponseError } from "./retryable-file-search"

async function withFetch<T>(answer: (url: string, init: RequestInit) => Response, run: (requests: Array<{ url: string; init: RequestInit }>) => Promise<T>) {
  const original = globalThis.fetch
  const requests: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return answer(String(input), init ?? {})
  }) as typeof fetch
  try { return await run(requests) } finally { globalThis.fetch = original }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const SPEC = "@neuralnomads/opencode-fixture@^0.1"

describe("integration install client", () => {
  it("posts the scope only, once, to the fixed route of the ID", async () => {
    await withFetch(() => json({ scope: "global", spec: SPEC, reloadPending: true }), async requests => {
      assert.deepEqual(await installIntegration("w 1", "/repo dir", "fixture", "global"), { scope: "global", spec: SPEC, reloadPending: true })
      assert.equal(requests.length, 1)
      assert.match(requests[0]!.url, /\/api\/workspaces\/w%201\/integrations\/fixture\/install\?directory=%2Frepo\+dir$/)
      assert.deepEqual([requests[0]!.init.method, requests[0]!.init.body, requests[0]!.init.cache], ["POST", JSON.stringify({ scope: "global" }), "no-store"])
    })
  })

  it("refuses an answer of another shape, scope or spec", async () => {
    for (const answer of [
      { scope: "global", spec: SPEC, reloadPending: true, path: "/config" }, { scope: "project", spec: SPEC, reloadPending: true },
      { scope: "global", spec: "", reloadPending: true }, { scope: "global", spec: 1, reloadPending: true },
      { scope: "global", spec: SPEC, reloadPending: false }, { scope: "global", spec: SPEC }, null, [],
    ]) {
      await withFetch(() => json(answer), () => assert.rejects(installIntegration("w", "/repo", "fixture", "global"), /Invalid integration install response/, JSON.stringify(answer)))
    }
  })

  it("surfaces the fixed refusal code and status without parsing anything else", async () => {
    await withFetch(() => json({ error: "Integration install duplicate", code: "duplicate" }, 409), async requests => {
      await assert.rejects(installIntegration("w", "/repo", "fixture", "global"),
        (error: unknown) => error instanceof HttpResponseError && error.status === 409 && error.code === "duplicate")
      assert.equal(requests.length, 1, "never replayed")
    })
    await withFetch(() => new Response("not json", { status: 503 }), () => assert.rejects(installIntegration("w", "/repo", "fixture", "global"),
      (error: unknown) => error instanceof HttpResponseError && error.status === 503 && error.code === undefined))
  })
})
