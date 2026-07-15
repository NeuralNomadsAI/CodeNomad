import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { BinaryResolver } from "./binaries"
import type { SettingsService } from "./service"

describe("BinaryResolver", () => {
  it("uses an explicit workspace binary without changing the configured default", () => {
    const settings = {
      getOwner(scope: string, owner: string) {
        if (scope === "config" && owner === "server") return { opencodeBinary: "default-opencode" }
        if (scope === "state" && owner === "ui") return { opencodeBinaries: [{ path: "saved-opencode", label: "Saved", version: "1.2.3" }] }
        return {}
      },
    } as unknown as SettingsService
    const resolver = new BinaryResolver(settings)
    assert.deepEqual(resolver.resolve("saved-opencode"), { path: "saved-opencode", label: "Saved", version: "1.2.3" })
    assert.equal(resolver.resolveDefault().path, "default-opencode")
  })
})
