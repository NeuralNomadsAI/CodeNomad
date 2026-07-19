import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createOpencodeYoloPersistence, hasPersistedYolo, mergePersistedYolo } from "./opencode-yolo-metadata"

describe("OpenCode Yolo metadata", () => {
  it("preserves unrelated metadata while replacing Yolo state", () => {
    assert.deepEqual(
      mergePersistedYolo({ thirdParty: { keep: true }, codenomad: { version: 1, worktreeSlug: "feature" } }, "root", true),
      {
        thirdParty: { keep: true },
        codenomad: { version: 1, worktreeSlug: "feature", yolo: { enabled: true, rootSessionId: "root" } },
      },
    )
  })

  it("accepts only a marker owned by its session", () => {
    const metadata = mergePersistedYolo({}, "root", true)
    assert.equal(hasPersistedYolo("root", metadata), true)
    assert.equal(hasPersistedYolo("fork", metadata), false)
    assert.equal(hasPersistedYolo("root", mergePersistedYolo({}, "root", false)), false)
  })

  it("uses the session workspace for metadata updates", async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        async list() { return { data: [{ id: "root", parentID: null, workspaceID: "workspace", metadata: {} }] } },
        async get(parameters: Record<string, unknown>) { calls.push(parameters); return { data: { metadata: {} } } },
        async update(parameters: Record<string, unknown>) { calls.push(parameters); return { data: {} } },
      },
    }
    const persistence = createOpencodeYoloPersistence({} as never, () => client as never)
    const [session] = await persistence.loadSessions("instance")
    await persistence.persist("instance", "root", true, session?.workspaceId)
    assert.equal(session?.workspaceId, "workspace")
    assert.equal(calls[0]?.workspace, "workspace")
    assert.equal(calls[1]?.workspace, "workspace")
  })

  it("serializes Yolo and worktree metadata writes across instances", async () => {
    let metadata: Record<string, unknown> = { thirdParty: true }
    const client = {
      session: {
        async get() { return { data: { metadata } } },
        async update(parameters: Record<string, unknown>) {
          metadata = parameters.metadata as Record<string, unknown>
          return { data: { metadata } }
        },
      },
    }
    const persistence = createOpencodeYoloPersistence({} as never, () => client as never)
    await Promise.all([
      persistence.persist("instance-a", "root", true),
      persistence.setWorktreeSlug("instance-b", "root", "feature"),
    ])
    assert.deepEqual(metadata, {
      thirdParty: true,
      codenomad: { version: 1, yolo: { enabled: true, rootSessionId: "root" }, worktreeSlug: "feature" },
    })
  })
})
