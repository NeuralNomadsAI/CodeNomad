import assert from "node:assert/strict"
import test from "node:test"
import { readAgentMissionProject } from "./mission-agent-read"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { parseInspectInput } from "../../opencode/missions-plugin"
import { parseProjectRead } from "../../missions/project-read-tool"
import { missionPlaybookDetails } from "../../missions/recipes"

function fixture() {
  const directory = process.cwd(), workspace = { id: "owned" }, calls: string[] = []
  const state = { projectID: "project", owned: true, ambiguous: false, responseProject: "project", moved: false }
  const rpc = {
    panelPage: async (input: unknown) => {
      calls.push(JSON.stringify(input))
      return { available: true, projectID: state.responseProject, source: "cleanups", entries: [{ requestID: "human_cleanup" }] }
    },
    recurrenceCurrent: async () => ({ projectID: state.responseProject, projectCanonical: directory, location: { directory },
      scheduleID: "human_schedule", ownerRevision: 7, passageID: "current_passage" }),
  }
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "ses_parent", projectID: state.projectID,
        location: { directory: state.moved ? `${directory}/moved` : directory } }),
      list: async (input: object) => { calls.push(JSON.stringify(input)); return { data: [
        { id: "ses_visible", projectID: "project", location: { directory }, title: "Human conversation" },
        { id: "ses_foreign", projectID: "foreign", location: { directory }, title: "Foreign" },
        { id: "ses_cn_schedule_technical", projectID: "project", location: { directory }, title: "Carrier" },
      ], cursor: { next: "native_next" } } },
    },
    location: { get: async () => ({ directory, project: { id: "project", canonical: directory } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => rpc,
  }
  const connection = { client, assertCurrent() {} }, another = { ...connection }
  const manager = {
    list: () => state.ambiguous ? [workspace, { id: "other" }] : [workspace],
    get: () => workspace, getServiceLocation: () => ({ directory }),
    getSharedServiceConnection: async (id: string) => id === "other" ? another : connection,
    ownsLocation: async (_id: string, location: { directory: string }) => state.owned && location.directory === directory,
    getServiceDirectoryForPath: async (_id: string, path: string) => path === directory ? directory : undefined,
    getWorktreeIdentityForPath: async () => directory,
  }
  const deps = { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(5000) }
  const read = (input: object, sessionID = "ses_descendant") => readAgentMissionProject(deps as never, sessionID,
    { kind: "project-read", input }, new AbortController().signal)
  return { read, state, calls }
}

test("owned descendants read human project cleanup without mutation", async () => {
  const f = fixture()
  const input = { kind: "panel", input: { source: "cleanups" } }
  const before = await f.read(input), replay = await f.read(input)
  assert.deepEqual(before, replay)
  assert.equal((before as any).entries[0].requestID, "human_cleanup")
  await assert.rejects(f.read({ kind: "current", input: { scheduleID: "human_schedule", owner: "scheduled" } }), /Unknown project Mission read/)
  assert.equal(f.calls.length, 2, "only the named pure native read runs")
})

test("source discovery uses explicit native pages and omits foreign conversations and carriers", async () => {
  const f = fixture()
  const first = await f.read({ kind: "sources", source: "conversations", search: "Human" }) as any
  assert.deepEqual(first.sources, [{ id: "ses_visible", title: "Human conversation" }])
  assert.equal(first.next, "native_next")
  await f.read({ kind: "sources", source: "conversations", cursor: first.next })
  assert.deepEqual(JSON.parse(f.calls[1]), { cursor: "native_next" })
  assert.equal(f.calls.length, 2, "continuations are explicit, never drained automatically")
})

test("project read refuses foreign or ambiguous owners and foreign replies", async () => {
  for (const key of ["owned", "ambiguous", "projectID", "responseProject", "moved"] as const) {
    const f = fixture()
    Object.assign(f.state, { [key]: key === "owned" ? false : key === "projectID" || key === "responseProject" ? "foreign" : true })
    await assert.rejects(f.read({ kind: "panel", input: { source: "cleanups" } }))
  }
})

test("all playbooks and both task modes expose the UI's exact recipes from an owned conversation without native effects", async () => {
  const f = fixture()
  for (const taskMode of ["native", "independent"] as const) {
    for (const playbook of missionPlaybookDetails(taskMode).playbooks) {
      const result = await f.read({ kind: "playbook", template: playbook.id, taskMode })
      assert.deepEqual(result, { taskMode, playbook })
      assert.ok(JSON.stringify(result, null, 2).length <= 100_000)
    }
  }
  assert.deepEqual(f.calls, [])
  f.state.owned = false
  await assert.rejects(f.read({ kind: "playbook", template: "custom" }))
  assert.throws(() => parseProjectRead({ kind: "playbook", template: "custom", taskMode: "forged" }))
})

test("project inspection validates pure methods before bridge dispatch", () => {
  assert.deepEqual(parseInspectInput({ project: { kind: "panel", input: { source: "cleanups" } } }),
    { project: { kind: "panel", input: { source: "cleanups" } } })
  for (const value of [
    { kind: "lifecycle", input: {} }, { kind: "panel", input: { source: "cleanups", write: true } },
    { kind: "sources", source: "repository", cursor: "forged" },
    { kind: "sources", source: "files" },
  ]) assert.throws(() => parseProjectRead(value))
  assert.throws(() => parseInspectInput({ missionID: "foreign", project: { kind: "panel", input: { source: "cleanups" } } }))
})
