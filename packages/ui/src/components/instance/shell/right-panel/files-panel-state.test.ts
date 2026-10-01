import assert from "node:assert/strict"
import { test } from "node:test"
import { mergeFilesPanelCustomization } from "./files-panel-state"

test("merging Git and Files preserves order and keeps either visible entry accessible", () => {
  const state = { tabOrder: ["status", "git-changes", "files"], hiddenTabIds: ["files"], statusSectionOrder: ["tokens"], hiddenStatusSectionIds: [] }
  assert.deepEqual(mergeFilesPanelCustomization(state), { ...state, tabOrder: ["status", "files"], hiddenTabIds: [] })
  assert.deepEqual(mergeFilesPanelCustomization({ ...state, hiddenTabIds: ["files", "git-changes"] }).hiddenTabIds, ["files"])
  assert.deepEqual(mergeFilesPanelCustomization({ ...state, tabOrder: ["files", "status", "git-changes"] }).tabOrder, ["files", "status"])
})
