import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { buildInstanceBaseUrl, createInstanceFetch, sdkManager } from "./sdk-manager.ts"
import { tGlobal } from "./i18n"

afterEach(() => {
  sdkManager.destroyClientsForInstance("instance-a")
  sdkManager.destroyClientsForInstance("instance-b")
})

describe("SDKManager", () => {
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
