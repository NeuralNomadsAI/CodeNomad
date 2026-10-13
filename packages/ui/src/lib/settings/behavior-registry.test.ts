import assert from "node:assert/strict"
import { test } from "node:test"
import type { Preferences } from "../../stores/preferences"
import { getBehaviorSettings, type BehaviorRegistryActions, type BehaviorToggleSetting } from "./behavior-registry"

test("hiding whitespace-only diff changes defaults on and persists through preferences", () => {
  const updates: Array<Partial<Preferences>> = []
  const actions = { preferences: () => ({}) as Preferences, updatePreferences: (update: Partial<Preferences>) => { updates.push(update) } }
  const setting = getBehaviorSettings(actions as unknown as BehaviorRegistryActions)
    .find(entry => entry.id === "behavior.hideDiffWhitespaceChanges") as BehaviorToggleSetting
  assert.equal(setting.kind, "toggle")
  assert.equal(setting.get({} as Preferences), true, "settings saved before the option existed hide whitespace")
  assert.equal(setting.get({ hideDiffWhitespaceChanges: false } as Preferences), false)
  setting.set(false)
  assert.deepEqual(updates, [{ hideDiffWhitespaceChanges: false }])
})
