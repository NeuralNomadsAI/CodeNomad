import assert from "node:assert/strict"
import { it } from "node:test"
import { createRoot, createSignal } from "solid-js"
import { clearInstanceDraftPrompts, getSessionDraftPrompt } from "../../stores/session-state.ts"
import { usePromptState } from "./usePromptState.ts"

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function mount(instanceId: string) {
  return createRoot((dispose) => ({
    dispose,
    state: usePromptState({ instanceId: () => instanceId, sessionId: () => "session", instanceFolder: () => "/fixture" }),
  }))
}

for (const clear of [false, true]) it(`a retiring prompt view cannot ${clear ? "resurrect a cleared" : "overwrite a newer"} draft`, async () => {
  const id = `retiring-prompt-${clear}`
  const old = mount(id)
  await flush()
  old.state.setPrompt("older view draft")
  const current = mount(id)
  await flush()
  try {
    if (clear) current.state.clearPrompt()
    else current.state.setPrompt("newer view draft")
    const expected = clear ? "" : "newer view draft"
    assert.equal(getSessionDraftPrompt(id, "session"), expected)
    old.dispose()
    assert.equal(getSessionDraftPrompt(id, "session"), expected, "Cleanup is not a new user edit")
    assert.equal(current.state.prompt(), expected)
  } finally {
    old.dispose()
    current.dispose()
    clearInstanceDraftPrompts(id)
  }
})

it("fresh input is already persisted before its view is disposed", async () => {
  const id = "retiring-prompt-fresh", view = mount(id)
  await flush()
  try {
    view.state.setPrompt("fresh draft")
    assert.equal(getSessionDraftPrompt(id, "session"), "fresh draft")
    view.dispose()
    assert.equal(getSessionDraftPrompt(id, "session"), "fresh draft")
  } finally { view.dispose(); clearInstanceDraftPrompts(id) }
})

it("switches sessions without losing either draft", async () => {
  const id = "prompt-session-switch"
  const [sessionId, select] = createSignal("first")
  const view = createRoot((dispose) => ({ dispose, state: usePromptState({
    instanceId: () => id, sessionId, instanceFolder: () => "/fixture",
  }) }))
  await flush()
  try {
    view.state.setPrompt("first draft")
    select("second")
    await flush()
    assert.equal(view.state.prompt(), "")
    view.state.setPrompt("second draft")
    select("first")
    await flush()
    assert.equal(view.state.prompt(), "first draft")
    assert.equal(getSessionDraftPrompt(id, "second"), "second draft")
  } finally { view.dispose(); clearInstanceDraftPrompts(id) }
})
