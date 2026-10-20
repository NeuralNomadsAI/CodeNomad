import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { defaultNotificationRouting, normalizeNotificationRouting, notificationTargets } from "./notification-routing"

describe("notification routing", () => {
  it("keeps session states out of history by default without changing their system route", () => {
    const routing = normalizeNotificationRouting(undefined)
    for (const category of ["needsInput", "sessionDone", "sessions"] as const) {
      assert.equal(routing[category].history, false)
      assert.equal(notificationTargets(undefined, category, "info").history, false)
    }
    assert.deepEqual(routing.needsInput, { screen: false, history: false, system: true })
    assert.deepEqual(routing.sessionDone, { screen: false, history: false, system: true })
    assert.deepEqual(routing.updates, { screen: true, history: true, system: true })
    assert.deepEqual(routing.projects, { screen: true, history: true, system: false }, "a tab closed elsewhere leaves a trace")
    for (const routine of ["copy", "settings", "sessions"] as const) {
      assert.deepEqual(routing[routine], { screen: true, history: false, system: false }, routine)
    }
  })

  it("preserves explicit session history choices and defaults omitted history to off", () => {
    const routing = normalizeNotificationRouting({
      needsInput: { history: true }, sessionDone: { history: false }, sessions: { history: true },
    })
    assert.equal(routing.needsInput.history, true)
    assert.equal(routing.sessionDone.history, false)
    assert.equal(routing.sessions.history, true)
    assert.equal(notificationTargets(routing, "needsInput", "info").history, true)
    const partial = normalizeNotificationRouting({ needsInput: { system: false }, sessionDone: { screen: true } })
    assert.equal(partial.needsInput.history, false)
    assert.equal(partial.sessionDone.history, false)
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
    // Product decision: a former switch that was never saved (its old default was off)
    // takes the new defaults, so upgrades get the System column like new installations.
    const neverSaved = normalizeNotificationRouting(undefined, {})
    assert.deepEqual(neverSaved, defaultNotificationRouting)
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
