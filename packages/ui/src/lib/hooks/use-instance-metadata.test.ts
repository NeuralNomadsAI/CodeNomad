import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { clearInstanceMetadata, getInstanceMetadata } from "../../stores/instance-metadata.ts"
import { hasMetadataLoaded, loadInstanceMetadata } from "./use-instance-metadata.ts"

describe("instance metadata", () => {
  it("fills VCS from the matching project list entry", async () => {
    const instanceId = "project-vcs"
    const locations: unknown[] = []
    const responseLocation = {
      directory: "/repo/worktree",
      project: { id: "project-1", directory: "/repo", canonical: "/repo" },
    }
    const client = {
      location: { get: async () => responseLocation },
      project: {
        list: async () => [{ id: "other", canonical: "/other", vcs: "hg" }, { id: "project-1", canonical: "/repo", vcs: "git" }],
      },
      mcp: {
        list: async (input: unknown) => {
          locations.push(input)
          return { location: responseLocation, data: [] }
        },
      },
      plugin: { list: async () => { throw new Error("generic metadata must not read plugins") } },
    }

    try {
      const location = { directory: "/repo/worktree" }
      await loadInstanceMetadata({ id: instanceId, folder: "/repo", client } as any, { location })
      assert.equal(getInstanceMetadata(instanceId)?.project?.vcs, "git")
      assert.equal(hasMetadataLoaded(getInstanceMetadata(instanceId), location), true)
      assert.equal(hasMetadataLoaded(getInstanceMetadata(instanceId), { directory: "/repo/worktree" }), true)
      assert.equal(hasMetadataLoaded(getInstanceMetadata(instanceId), { directory: "/repo" }), false)
      assert.deepEqual(locations, [{
        location: { directory: "/repo/worktree" },
      }])
    } finally {
      clearInstanceMetadata(instanceId)
    }
  })

  it("lets a replacement client load immediately and rejects the old commit", async () => {
    const instanceId = "metadata-client-replacement"
    let resolveOld!: () => void
    let resolveNew!: () => void
    const oldGate = new Promise<void>((resolve) => { resolveOld = resolve })
    const newGate = new Promise<void>((resolve) => { resolveNew = resolve })
    const client = (label: string, gate: Promise<void>) => ({
      location: { get: async () => { await gate; return { directory: `/${label}`, project: { id: label, directory: `/${label}`, canonical: `/${label}` } } } },
      project: {
        list: async () => { await gate; return [] },
      },
      mcp: { list: async () => { await gate; return { data: [label] } } },
      plugin: { list: async () => { throw new Error("generic metadata must not read plugins") } },
    })

    try {
      const oldRequest = loadInstanceMetadata({ id: instanceId, folder: "/old", client: client("old", oldGate) } as any)
      clearInstanceMetadata(instanceId)
      const newRequest = loadInstanceMetadata({ id: instanceId, folder: "/new", client: client("new", newGate) } as any)
      resolveNew()
      await newRequest
      assert.equal(getInstanceMetadata(instanceId)?.project?.id, "new")
      resolveOld()
      await oldRequest
      assert.equal(getInstanceMetadata(instanceId)?.project?.id, "new")
    } finally {
      clearInstanceMetadata(instanceId)
    }
  })

  it("treats location metadata as loaded without fetching plugin inventory", async () => {
    const instanceId = "metadata-location-partial-failure"
    const project = { id: "project", directory: "/repo", canonical: "/repo" }
    const client = {
      location: { get: async () => ({ directory: "/repo", project }) },
      project: {
        list: async () => [project],
      },
      mcp: {
        list: async ({ location }: any) => ({
          location: {
            directory: location.directory,
            project,
          },
          data: [],
        }),
      },
      plugin: { list: async () => { throw new Error("generic metadata must not read plugins") } },
    }

    try {
      await loadInstanceMetadata({ id: instanceId, folder: "/repo", client } as any)

      const worktree = { directory: "/repo/worktree" }
      await loadInstanceMetadata({ id: instanceId, folder: "/repo", client } as any, { location: worktree })

      const metadata = getInstanceMetadata(instanceId)
      assert.equal(metadata?.mcpStatus?.location.directory, worktree.directory)
      assert.equal(hasMetadataLoaded(metadata, worktree), true)
    } finally {
      clearInstanceMetadata(instanceId)
    }
  })
})
