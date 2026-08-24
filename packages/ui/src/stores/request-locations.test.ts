import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildV2RequestLocations, createRequestLocation, toRequestLocation } from "./request-locations.ts"

describe("createRequestLocation", () => {
  it("creates native request location shapes", () => {
    assert.deepEqual(createRequestLocation("/repo"), { directory: "/repo" })
    assert.deepEqual(createRequestLocation(), {})
  })
})

describe("toRequestLocation", () => {
  it("maps SDK output workspace IDs to native request selectors", () => {
    assert.deepEqual(toRequestLocation({ directory: "/repo", workspaceID: "workspace-1" }), {
      directory: "/repo",
      workspace: "workspace-1",
    })
    assert.deepEqual(toRequestLocation({ directory: "/repo" }), { directory: "/repo" })
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

  it("keeps workspace scopes that share a directory", () => {
    assert.deepEqual(buildV2RequestLocations("/repo", [
      { directory: "/repo", workspaceID: "one" },
      { directory: "/repo", workspaceID: "two" },
    ]), [
      { directory: "/repo" },
      { directory: "/repo", workspace: "one" },
      { directory: "/repo", workspace: "two" },
    ])
  })
})
