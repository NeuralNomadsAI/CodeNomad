import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildV2RequestLocations } from "./request-locations.ts"

describe("buildV2RequestLocations", () => {
  it("treats unavailable worktree discovery as incomplete", () => {
    assert.deepEqual(buildV2RequestLocations("/repo", [], new Map()), {
      locations: [{ directory: "/repo" }],
      complete: false,
    })
  })

  it("includes root and each workspace-backed worktree location", () => {
    const locations = buildV2RequestLocations(
      "/repo",
      [
        { slug: "root" },
        { slug: "feature-a" },
        { slug: "feature-b" },
      ],
      new Map([
        ["feature-a", "workspace-a"],
        ["feature-b", "workspace-b"],
      ]),
    )

    assert.deepEqual(locations, {
      locations: [
        { directory: "/repo" },
        { directory: "/repo", workspace: "workspace-a" },
        { directory: "/repo", workspace: "workspace-b" },
      ],
      complete: true,
    })
  })

  it("keeps root and known locations while marking unresolved worktrees incomplete", () => {
    assert.deepEqual(
      buildV2RequestLocations(
        "/repo",
        [{ slug: "known" }, { slug: "missing" }],
        new Map([["known", "workspace-known"]]),
      ),
      {
        locations: [
          { directory: "/repo" },
          { directory: "/repo", workspace: "workspace-known" },
        ],
        complete: false,
      },
    )
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

    assert.deepEqual(locations, {
      locations: [
        { directory: "/repo" },
        { directory: "/repo", workspace: "workspace-shared" },
      ],
      complete: true,
    })
  })
})
