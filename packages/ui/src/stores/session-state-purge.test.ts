import assert from "node:assert/strict"
import test from "node:test"
import {
  agents,
  loading,
  messagesLoaded,
  providers,
  purgeInstanceSessionState,
  sessionInfoByInstance,
  sessions,
  setAgents,
  setLoading,
  setMessagesLoaded,
  setProviders,
  setSessionInfoByInstance,
  setSessions,
} from "./session-state.ts"

test("purging an instance removes its session metadata without touching other workspaces", () => {
  const removed = "purged-instance"
  const retained = "retained-instance"
  setSessions(new Map([[removed, new Map()], [retained, new Map()]]))
  setAgents(new Map([[removed, []], [retained, []]]))
  setProviders(new Map([[removed, []], [retained, []]]))
  setMessagesLoaded(new Map([[removed, new Set(["session"])], [retained, new Set<string>()]]))
  setSessionInfoByInstance(new Map([[removed, new Map()], [retained, new Map()]]))
  setLoading((current) => ({ ...current, loadingMessages: new Map([[removed, new Set(["session"])], [retained, new Set()]]) }))

  purgeInstanceSessionState(removed)

  for (const state of [sessions(), agents(), providers(), messagesLoaded(), sessionInfoByInstance(), loading().loadingMessages]) {
    assert.equal(state.has(removed), false)
    assert.equal(state.has(retained), true)
  }
  purgeInstanceSessionState(retained)
})
