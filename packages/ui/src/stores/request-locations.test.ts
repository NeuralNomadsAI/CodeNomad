import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildV2RequestLocations, createRequestLocation, locationAuthorityKey, requestLocationOptions, toRequestLocation } from "./request-locations.ts"

describe("createRequestLocation", () => {
  it("creates native request location shapes", () => {
    assert.deepEqual(createRequestLocation("/repo"), { directory: "/repo" })
    assert.deepEqual(createRequestLocation(), {})
  })
})

describe("toRequestLocation", () => {
  it("uses directory-only native request selectors", () => {
    assert.deepEqual(toRequestLocation({ directory: "/repo", workspaceID: "workspace-1" }), {
      directory: "/repo",
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

  it("retains distinct native identities sharing a directory", () => {
    assert.deepEqual(buildV2RequestLocations("/repo", [
      { directory: "/repo", workspaceID: "one" },
      { directory: "/repo", workspaceID: "two" },
    ]), [
      { directory: "/repo" },
      { directory: "/repo", workspaceID: "one" },
      { directory: "/repo", workspaceID: "two" },
    ])
  })
})

it("carries legacy identity separately from modern public selectors", () => {
  const location = { directory: "/工作/100% ready", workspaceID: "legacy-one" }
  const publicLocation = toRequestLocation(location)
  assert.deepEqual(publicLocation, { directory: location.directory })
  const options = requestLocationOptions(location)!
  assert.deepEqual(JSON.parse(decodeURIComponent(options.headers["x-codenomad-location"])), location)
  assert.equal(requestLocationOptions(publicLocation), undefined)
  assert.deepEqual(JSON.parse(decodeURIComponent(requestLocationOptions(publicLocation, { includeDirectory: true })!.headers["x-codenomad-location"])), publicLocation)
  assert.notEqual(locationAuthorityKey(location), locationAuthorityKey({ ...location, workspaceID: "legacy-two" }))
})
