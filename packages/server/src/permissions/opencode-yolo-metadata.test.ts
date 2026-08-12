import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode-ai/client"

import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import { createOpencodeYoloPersistence } from "./opencode-yolo-metadata"

function createHarness() {
  let owner: Record<string, unknown> = {}
  const settings = {
    getOwner: () => owner,
    mergePatchOwner: (_kind: string, _owner: string, patch: { sessions: Record<string, unknown> }) => {
      owner = {
        ...owner,
        sessions: { ...((owner.sessions as Record<string, unknown>) ?? {}), ...patch.sessions },
      }
      return owner
    },
  } as unknown as SettingsService
  const workspaceManager = { get: () => ({ path: "/repo" }) } as unknown as WorkspaceManager
  const client = {
    session: {
      async list(input: Record<string, unknown>) {
        assert.deepEqual(input, { directory: "/repo", limit: 10_000 })
        return {
          data: [
            {
              id: "root",
              parentID: undefined,
              revert: undefined,
              location: { directory: "/repo", workspaceID: "workspace" },
            },
          ],
          cursor: {},
        }
      },
    },
  } as unknown as OpenCodeClient
  const persistence = createOpencodeYoloPersistence(
    workspaceManager,
    settings,
    async () => client,
  )
  return { persistence }
}

describe("OpenCode Yolo persistence", () => {
  it("loads native sessions and Yolo state from the CodeNomad store", async () => {
    const { persistence } = createHarness()
    await persistence.persist("instance", "root", true)

    assert.deepEqual(await persistence.loadSessions("instance"), [
      {
        id: "root",
        parentId: null,
        revert: undefined,
        workspaceId: "workspace",
        yoloEnabled: true,
      },
    ])
  })

})
