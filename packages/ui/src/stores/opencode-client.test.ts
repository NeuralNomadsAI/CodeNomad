import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildRootProxyPath } from "./opencode-client.ts"

describe("buildRootProxyPath", () => {
  it("encodes the instance id", () => {
    assert.equal(buildRootProxyPath("instance/a b"), "/workspaces/instance%2Fa%20b/instance")
  })
})
