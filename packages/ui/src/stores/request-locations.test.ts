import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildV2RequestLocations } from "./request-locations.ts"

describe("buildV2RequestLocations", () => {
  it("includes root and each workspace-backed worktree location", () => {
    const locations = buildV2RequestLocations(
      "/repo",
      [
        { slug: "root" },
        { slug: "feature-a" },
        { slug: "feature-b" },
        { slug: "missing-workspace" },
      ],
      new Map([
        ["feature-a", "workspace-a"],
        ["feature-b", "workspace-b"],
      ]),
    )

    assert.deepEqual(locations, [
      { directory: "/repo" },
      { directory: "/repo", workspace: "workspace-a" },
      { directory: "/repo", workspace: "workspace-b" },
    ])
  })

  it("deduplicates repeated workspace locations", () => {
    const locations = buildV2RequestLocations(
      "/repo",
      [{ slug: "feature-a" }, { slug: "feature-b" }],
      new Map([
        ["feature-a", "workspace-shared"],
        ["feature-b", "workspace-shared"],
      ]),
    )

    assert.deepEqual(locations, [
      { directory: "/repo" },
      { directory: "/repo", workspace: "workspace-shared" },
    ])
  })
})
