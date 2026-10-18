import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { defaultNotificationRouting, normalizeNotificationRouting, notificationTargets } from "./notification-routing"

describe("notification routing", () => {
  it("keeps the history (and badge) for attention and events, not routine feedback", () => {
    const routing = normalizeNotificationRouting(undefined)
    assert.deepEqual(routing.needsInput, { screen: false, history: true, system: true })
    assert.deepEqual(routing.sessionDone, { screen: false, history: true, system: true })
    assert.deepEqual(routing.updates, { screen: true, history: true, system: true })
    assert.deepEqual(routing.projects, { screen: true, history: true, system: false }, "a tab closed elsewhere leaves a trace")
    for (const routine of ["copy", "settings", "sessions"] as const) {
      assert.deepEqual(routing[routine], { screen: true, history: false, system: false }, routine)
    }
  })

  it("keeps saved choices, fills missing destinations and drops unknown entries without mutating input", () => {
    const saved = { copy: { screen: false }, files: { history: false, system: "yes" }, unknown: { screen: true } }
    const routing = normalizeNotificationRouting(saved)
    assert.deepEqual(routing.copy, { screen: false, history: false, system: false })
    assert.deepEqual(routing.files, { screen: true, history: false, system: false })
    assert.equal("unknown" in routing, false)
    assert.deepEqual(saved.files, { history: false, system: "yes" })
  })

  it("seeds the system column from the former system settings until routing is saved", () => {
    const off = normalizeNotificationRouting(undefined, { osNotificationsEnabled: false, notifyOnNeedsInput: true, notifyOnIdle: true })
    for (const category of Object.keys(off) as Array<keyof typeof off>) assert.equal(off[category].system, false, category)
    const perEvent = normalizeNotificationRouting(undefined, { osNotificationsEnabled: true, notifyOnNeedsInput: false, notifyOnIdle: true })
    assert.equal(perEvent.needsInput.system, false)
    assert.equal(perEvent.sessionDone.system, true)
    assert.equal(perEvent.updates.system, true)
    // Once routing exists, the former switch no longer applies.
    const saved = normalizeNotificationRouting({ updates: { system: true } }, { osNotificationsEnabled: false })
    assert.equal(saved.updates.system, true)
    assert.equal(saved.needsInput.system, defaultNotificationRouting.needsInput.system)
  })

  it("always keeps an error on screen and in the history while the system follows its category", () => {
    const routing = normalizeNotificationRouting({ sessions: { screen: false, history: false, system: false } })
    assert.deepEqual(notificationTargets(routing, "sessions", "error"), { screen: true, history: true, system: false })
    assert.deepEqual(notificationTargets(routing, "sessions", "warning"), { screen: false, history: false, system: false })
    assert.deepEqual(notificationTargets(undefined, "copy", "success"), { screen: true, history: false, system: false })
  })
})
