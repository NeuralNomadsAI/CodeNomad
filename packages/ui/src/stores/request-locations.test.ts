import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildV2RequestLocations, createRequestLocation } from "./request-locations.ts"

describe("createRequestLocation", () => {
  it("creates native request location shapes", () => {
    assert.deepEqual(createRequestLocation("/repo"), { directory: "/repo" })
    assert.deepEqual(createRequestLocation(), {})
  })
})

describe("buildV2RequestLocations", () => {
  it("includes root and each worktree directory", () => {
    const locations = buildV2RequestLocations(
      "/repo",
      [
        { directory: "/repo" },
        { directory: "/repo-feature-a" },
        { directory: "/repo-feature-b" },
        {},
      ],
    )

    assert.deepEqual(locations, [
      { directory: "/repo" },
      { directory: "/repo-feature-a" },
      { directory: "/repo-feature-b" },
    ])
  })

  it("deduplicates repeated directories", () => {
    const locations = buildV2RequestLocations(
      "/repo",
      [{ directory: "/repo-feature" }, { directory: "/repo-feature" }],
    )

    assert.deepEqual(locations, [
      { directory: "/repo" },
      { directory: "/repo-feature" },
    ])
  })
})
