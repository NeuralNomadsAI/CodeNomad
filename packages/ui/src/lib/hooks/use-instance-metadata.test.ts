import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { extractConfiguredPlugins } from "./plugin-metadata.ts"
import { clearInstanceMetadata, getInstanceMetadata } from "../../stores/instance-metadata.ts"
import { hasMetadataLoaded, loadInstanceMetadata } from "./use-instance-metadata.ts"

describe("extractConfiguredPlugins", () => {
  it("normalizes string plugin entries", () => {
    assert.deepEqual(extractConfiguredPlugins(["npm:user-plugin", "file:///tmp/plugin.ts"]), [
      "npm:user-plugin",
      "/tmp/plugin.ts",
    ])
  })

  it("reads tuple plugin specifiers without crashing", () => {
    assert.deepEqual(
      extractConfiguredPlugins([
        ["@neuralnomads/nomadworks", { onboarding: "auto" }],
        ["file:///tmp/plugin.ts", { enabled: true }],
      ]),
      ["@neuralnomads/nomadworks", "/tmp/plugin.ts"],
    )
  })

  it("ignores invalid plugin entry shapes", () => {
    assert.deepEqual(
      extractConfiguredPlugins([
        [123, { invalid: true }],
        { plugin: "bad" },
        ["missing-options"],
        ["bad-options", "not-options"],
        ["array-options", []],
        ["npm:good-plugin", { ok: true }],
      ]),
      ["npm:good-plugin"],
    )
  })

  it("returns an empty list for non-array plugin config", () => {
    assert.deepEqual(extractConfiguredPlugins(undefined), [])
    assert.deepEqual(extractConfiguredPlugins("npm:user-plugin"), [])
  })
})

describe("instance metadata", () => {
  it("fills VCS from the matching project list entry", async () => {
    const instanceId = "project-vcs"
    const client = {
      project: {
        current: async () => ({ id: "project-1", directory: "/repo", canonical: "/repo" }),
        list: async () => [{ id: "other", canonical: "/other", vcs: "hg" }, { id: "project-1", canonical: "/repo", vcs: "git" }],
      },
      mcp: { list: async () => ({ location: { directory: "/repo", project: { id: "project-1", directory: "/repo", canonical: "/repo" } }, data: [] }) },
      config: { get: async () => [] },
    }

    try {
      await loadInstanceMetadata({ id: instanceId, folder: "/repo", client } as any)
      assert.equal(getInstanceMetadata(instanceId)?.project?.vcs, "git")
      assert.equal(hasMetadataLoaded(getInstanceMetadata(instanceId)), true)
    } finally {
      clearInstanceMetadata(instanceId)
    }
  })
})
