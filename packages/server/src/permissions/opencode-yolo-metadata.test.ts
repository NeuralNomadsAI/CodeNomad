import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode-ai/client"

import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import { createOpencodeYoloPersistence } from "./opencode-yolo-metadata"

function createHarness(serviceDirectory = "/repo") {
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
  const listInputs: Record<string, unknown>[] = []
  const workspaceManager = {
    get: () => ({ path: "/repo" }),
    getServiceDirectory: () => serviceDirectory,
    ownsDirectory: async (_instanceId: string, directory: string) => directory === "/repo" || directory === "/worktree",
  } as unknown as WorkspaceManager
  const client = {
    session: {
      async list(input: Record<string, unknown>) {
        listInputs.push(input)
        const cursor = input.cursor
        return {
          data: cursor ? [
            {
              id: "second-page",
              parentID: undefined,
              fork: undefined,
              location: { directory: "/repo", workspaceID: "workspace" },
            },
          ] : [
            {
              id: "root",
              parentID: undefined,
              fork: undefined,
              location: { directory: "/repo", workspaceID: "workspace" },
            },
          ],
          cursor: { next: cursor ? null : "page-2" },
        }
      },
      async get({ sessionID }: { sessionID: string }) {
        return {
          id: sessionID,
          parentID: undefined,
          fork: sessionID === "worktree" ? {
            sessionID: "root",
            boundary: { type: "through", messageID: "message" },
          } : undefined,
          location: {
            directory: sessionID === "foreign" ? "/other" : sessionID === "worktree" ? "/worktree" : "/repo",
            workspaceID: "workspace",
          },
        }
      },
    },
  } as unknown as OpenCodeClient
  const persistence = createOpencodeYoloPersistence(
    workspaceManager,
    settings,
    async () => client,
  )
  return { persistence, listInputs }
}

describe("OpenCode Yolo persistence", () => {
  it("loads native sessions and Yolo state from the CodeNomad store", async () => {
    const { persistence, listInputs } = createHarness()
    await persistence.persist("instance", "root", true)

    assert.deepEqual(await persistence.loadSessions("instance"), [
      {
        id: "root",
        parentId: null,
        fork: undefined,
        yoloEnabled: true,
      },
      {
        id: "second-page",
        parentId: null,
        fork: undefined,
        yoloEnabled: false,
      },
    ])
    assert.deepEqual(listInputs, [
      { directory: "/repo", limit: 10_000 },
      { cursor: "page-2" },
    ])
  })

  it("loads an exact session only when its native location belongs to the logical workspace", async () => {
    const { persistence } = createHarness()
    assert.equal((await persistence.loadSession!("instance", "root"))?.id, "root")
    assert.equal(await persistence.loadSession!("instance", "foreign"), null)
  })

  it("restores a persisted Yolo session from an owned worktree", async () => {
    const { persistence } = createHarness()
    await persistence.persist("instance", "worktree", true)

    const worktree = (await persistence.loadSessions("instance")).find((session) => session.id === "worktree")
    assert.deepEqual(worktree, {
      id: "worktree",
      parentId: null,
      fork: { sessionID: "root", boundary: { type: "through", messageID: "message" } },
      yoloEnabled: true,
    })
  })

})
