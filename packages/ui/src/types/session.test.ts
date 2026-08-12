import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createClientSession, getSelectableAgentsForSession, isSelectablePrimaryAgent, type Agent } from "./session.ts"

const visiblePrimary: Agent = { name: "plan", description: "", mode: "primary" }
const visibleSubagent: Agent = { name: "review", description: "", mode: "subagent" }
const hiddenPrimary: Agent = { name: "build", description: "", mode: "primary", hidden: true }
const hiddenSubagent: Agent = { name: "debug", description: "", mode: "subagent", hidden: true }

describe("agent selectability", () => {
  it("keeps native session location authoritative", () => {
    const session = createClientSession({
      id: "session",
      projectID: "project",
      title: "Session",
      location: { directory: "D:/repo/worktree", workspaceID: "workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }, "instance")

    assert.deepEqual(session.location, { directory: "D:/repo/worktree", workspaceID: "workspace" })
  })

  it("matches primary-session selector rules", () => {
    assert.equal(isSelectablePrimaryAgent(visiblePrimary), true)
    assert.equal(isSelectablePrimaryAgent(visibleSubagent), false)
    assert.equal(isSelectablePrimaryAgent(hiddenPrimary), false)
    assert.equal(isSelectablePrimaryAgent(hiddenSubagent), false)
  })

  it("excludes hidden and subagent entries from main-session selectors", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "build", false).map((agent) => agent.name),
      ["plan"],
    )
  })

  it("preserves a child session's current hidden agent for steering", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "build", true).map((agent) => agent.name),
      ["review", "plan", "build"],
    )
  })

  it("does not add unrelated hidden agents to child-session selectors", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "review", true).map((agent) => agent.name),
      ["review", "plan"],
    )
  })
})
