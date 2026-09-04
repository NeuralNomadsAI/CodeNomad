import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { BinaryResolver } from "./binaries"
import type { SettingsService } from "./service"

describe("BinaryResolver", () => {
  it("uses the configured global binary", () => {
    const settings = {
      getOwner(scope: string, owner: string) {
        if (scope === "config" && owner === "server") return { opencodeBinary: "default-opencode" }
        if (scope === "state" && owner === "ui") return { opencodeBinaries: [{ path: "default-opencode", label: "Custom", version: "1.2.3" }] }
        return {}
      },
    } as unknown as SettingsService
    const resolver = new BinaryResolver(settings)
    assert.deepEqual(resolver.resolveDefault(), { path: "default-opencode", label: "Custom", version: "1.2.3" })
  })

  it("defaults to opencode2", () => {
    const settings = {
      getOwner: (scope: string, owner: string) => scope === "state" && owner === "ui"
        ? { opencodeBinaries: [{ path: "listed-but-not-global" }] }
        : {},
    } as unknown as SettingsService
    assert.equal(new BinaryResolver(settings).resolveDefault().path, "opencode2")
  })

  it("upgrades the legacy bare opencode default to opencode2", () => {
    const settings = {
      getOwner(scope: string, owner: string) {
        if (scope === "config" && owner === "server") return { opencodeBinary: "opencode" }
        return {}
      },
    } as unknown as SettingsService

    assert.equal(new BinaryResolver(settings).resolveDefault().path, "opencode2")
  })
})
