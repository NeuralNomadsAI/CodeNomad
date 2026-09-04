import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { buildInstanceBaseUrl, sdkManager } from "./sdk-manager.ts"

afterEach(() => {
  sdkManager.destroyClientsForInstance("instance-a")
  sdkManager.destroyClientsForInstance("instance-b")
})

describe("SDKManager", () => {
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
