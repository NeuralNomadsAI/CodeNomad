import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createClientSession, findAgentById, getSelectableAgentsForSession, isSelectablePrimaryAgent, resolveAgentId, type Agent } from "./session.ts"

const visiblePrimary: Agent = { id: "plan", name: "Plan", description: "", mode: "primary" }
const visibleSubagent: Agent = { id: "review", name: "Review", description: "", mode: "subagent" }
const hiddenPrimary: Agent = { id: "build", name: "Build", description: "", mode: "primary", hidden: true }
const hiddenSubagent: Agent = { id: "debug", name: "Debug", description: "", mode: "subagent", hidden: true }

describe("agent selectability", () => {
  it("keeps native session location and metadata authoritative", () => {
    const session = createClientSession({
      id: "session",
      projectID: "project",
      title: "Session",
      location: { directory: "D:/repo/worktree", workspaceID: "workspace" },
      metadata: { persisted: true },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }, "instance")

    assert.deepEqual(session.location, { directory: "D:/repo/worktree", workspaceID: "workspace" })
    assert.deepEqual(session.metadata, { persisted: true })
  })

  it("matches primary-session selector rules", () => {
    assert.equal(isSelectablePrimaryAgent(visiblePrimary), true)
    assert.equal(isSelectablePrimaryAgent(visibleSubagent), false)
    assert.equal(isSelectablePrimaryAgent(hiddenPrimary), false)
    assert.equal(isSelectablePrimaryAgent(hiddenSubagent), false)
  })

  it("maps a persisted display name only when the catalog provides its API id", () => {
    assert.equal(resolveAgentId([visiblePrimary], "Plan"), "plan")
    assert.equal(resolveAgentId([visiblePrimary], "Unknown"), "Unknown")
    assert.equal(resolveAgentId([visiblePrimary, { ...visiblePrimary, id: "other" }], "Plan"), "Plan")
  })

  it("keeps selector identity on Agent.id when display-name casing differs", () => {
    const build: Agent = { id: "build", name: "Build", description: "", mode: "primary" }

    assert.equal(findAgentById([build], "build"), build)
    assert.equal(findAgentById([build], "Build"), undefined)
    assert.equal(resolveAgentId([{ ...visiblePrimary, name: "build" }, build], "build"), "build")
  })

  it("excludes hidden and subagent entries from main-session selectors", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "build", false).map((agent) => agent.name),
      ["Plan"],
    )
  })

  it("preserves a child session's current hidden agent for steering", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "build", true).map((agent) => agent.name),
      ["Review", "Plan", "Build"],
    )
  })

  it("does not add unrelated hidden agents to child-session selectors", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "review", true).map((agent) => agent.name),
      ["Review", "Plan"],
    )
  })
})
