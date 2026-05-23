import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { confirmSubagentsInheritYoloModeChange, createSubagentYoloConfirmDialogArgs } from "./yolo-confirmation.ts"

describe("subagent YOLO preference confirmation", () => {
  it("requires the explicit subagent YOLO confirmation before enabling", async () => {
    let called = false
    const [message, options] = createSubagentYoloConfirmDialogArgs((key) => ({
      "instanceShell.yoloMode.subagents.confirm.body": "Subagents may execute commands or make file changes without additional approval prompts. Only enable this in trusted workspaces.",
      "instanceShell.yoloMode.subagents.confirm.title": "Enable YOLO Mode for Subagents?",
      "instanceShell.yoloMode.subagents.confirm.enable": "Enable for Subagents",
      "instanceShell.yoloMode.subagents.confirm.cancel": "Cancel",
    })[key] ?? key)

    const confirmed = await (async () => {
      called = true
      assert.equal(options?.title, "Enable YOLO Mode for Subagents?")
      assert.equal(message, "Subagents may execute commands or make file changes without additional approval prompts. Only enable this in trusted workspaces.")
      assert.equal(options?.confirmLabel, "Enable for Subagents")
      assert.equal(options?.cancelLabel, "Cancel")
      assert.equal(options?.variant, "warning")
      return true
    })()

    assert.equal(called, true)
    assert.equal(confirmed, true)
  })

  it("keeps the preference disabled when enabling is not confirmed", async () => {
    let confirmed = false
    const shouldUpdate = await confirmSubagentsInheritYoloModeChange(false, true, async () => {
      confirmed = true
      return false
    })

    assert.equal(confirmed, true)
    assert.equal(shouldUpdate, false)
  })

  it("does not require confirmation when disabling", async () => {
    let confirmed = false
    const shouldUpdate = await confirmSubagentsInheritYoloModeChange(true, false, async () => {
      confirmed = true
      return true
    })

    assert.equal(confirmed, false)
    assert.equal(shouldUpdate, true)
  })
})
