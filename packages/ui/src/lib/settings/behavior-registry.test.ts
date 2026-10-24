import assert from "node:assert/strict"
import { test } from "node:test"
import type { Preferences } from "../../stores/preferences"
import { getBehaviorSettings, getBehaviorCommands, type BehaviorRegistryActions, type BehaviorToggleSetting } from "./behavior-registry"

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

test("message tokens default hidden without discarding explicit visibility or breaking the toggle command", () => {
  let current = {} as Preferences
  let toggles = 0
  const actions = {
    preferences: () => current,
    toggleUsageMetrics: () => { toggles++; current = { ...current, showUsageMetrics: !current.showUsageMetrics } },
  } as BehaviorRegistryActions
  const setting = getBehaviorSettings(actions).find(entry => entry.id === "behavior.usageMetrics") as BehaviorToggleSetting
  assert.equal(setting.get(current), false)
  setting.set(false)
  assert.equal(toggles, 0, "an absent saved value already means hidden")
  setting.set(true)
  assert.equal(setting.get(current), true)
  const command = getBehaviorCommands(actions).find(entry => entry.id === "token-usage-visibility")!
  command.action()
  assert.equal(setting.get(current), false)
  current = { ...current, showUsageMetrics: true }
  assert.equal(setting.get(current), true, "explicit saved choices win")
})
