import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { clearInstanceMetadata, getInstanceMetadata } from "../../stores/instance-metadata.ts"
import { hasMetadataLoaded, loadInstanceMetadata } from "./use-instance-metadata.ts"

describe("instance metadata", () => {
  it("fills VCS from the matching project list entry", async () => {
    const instanceId = "project-vcs"
    const client = {
      project: {
        current: async () => ({ id: "project-1", directory: "/repo", canonical: "/repo" }),
        list: async () => [{ id: "other", canonical: "/other", vcs: "hg" }, { id: "project-1", canonical: "/repo", vcs: "git" }],
      },
      mcp: { list: async () => ({ location: { directory: "/repo", project: { id: "project-1", directory: "/repo", canonical: "/repo" } }, data: [] }) },
      plugin: { list: async () => ({ location: { directory: "/repo", project: { id: "project-1", directory: "/repo", canonical: "/repo" } }, data: [{ id: "opencode.plan" }, { id: "ponytail" }, { status: "failed", error: "broken" }] }) },
    }

    try {
      await loadInstanceMetadata({ id: instanceId, folder: "/repo", client } as any)
      assert.equal(getInstanceMetadata(instanceId)?.project?.vcs, "git")
      assert.deepEqual(getInstanceMetadata(instanceId)?.plugins, ["ponytail"])
      assert.equal(hasMetadataLoaded(getInstanceMetadata(instanceId)), true)
    } finally {
      clearInstanceMetadata(instanceId)
    }
  })
})
