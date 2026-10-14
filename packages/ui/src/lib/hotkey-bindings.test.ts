import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { hotkeyDefinitions } from "./hotkey-definitions"
import { applyMergePatch } from "../../../server/src/settings/merge-patch"
import { findHotkeyConflicts, formatHotkeyBinding, hotkeyEventKey, hotkeyOverridePatch, matchesHotkeyBinding,
  normalizeHotkeyOverrides, resetHotkeyOverridesPatch, resolveHotkeyBindings, type HotkeyBinding, type HotkeyOverrides } from "./hotkey-bindings"

const event = (key: string, values: Partial<KeyboardEvent> = {}) => ({
  key, code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...values,
})

describe("hotkey catalog and effective bindings", () => {
  it("provides every action and manager label in all ten locales without duplicate keys", async () => {
    for (const locale of ["de", "en", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
      const module = await import(new URL(`./i18n/messages/${locale}/index.ts`, import.meta.url).href)
      const messages = Object.values(module).find(value => value && typeof value === "object") as Record<string, string>
      for (const key of ["settings.nav.hotkeys", "hotkeys.edit", "hotkeys.capture", "hotkeys.disabled", "hotkeys.disable",
        "hotkeys.reset", "hotkeys.resetAll", "hotkeys.cancel", "hotkeys.filter", "hotkeys.saveFailed", "hotkeys.conflict",
        ...hotkeyDefinitions.map(definition => definition.labelKey)]) {
        assert.equal(typeof messages?.[key], "string", `${locale}: ${key}`)
      }
    }
  })

  it("has 49 unique renderer actions with defaults, available without app registration", () => {
    assert.equal(hotkeyDefinitions.length, 49)
    assert.equal(new Set(hotkeyDefinitions.map(item => item.id)).size, hotkeyDefinitions.length)
    for (const { id, labelKey } of hotkeyDefinitions) {
      assert.ok(labelKey.startsWith("hotkeys.action."))
      assert.ok(resolveHotkeyBindings(id, {}).length, id)
    }
    assert.equal(hotkeyDefinitions.find(item => item.id === "app-tab-9")?.labelKey, "hotkeys.action.app-tab")
  })

  it("keeps the saved Enter policy as a default, with explicit disabled and custom overrides", () => {
    assert.deepEqual(resolveHotkeyBindings("prompt-send", {}, true), [{ key: "Enter" }])
    assert.deepEqual(resolveHotkeyBindings("prompt-send", {}, false), [{ key: "Enter", mod: true }])
    assert.deepEqual(resolveHotkeyBindings("prompt-newline", {}, true), [{ key: "Enter", shift: true }, { key: "Enter", mod: true }])
    assert.deepEqual(resolveHotkeyBindings("prompt-newline", {}, false), [{ key: "Enter" }, { key: "Enter", shift: true }])
    assert.deepEqual(resolveHotkeyBindings("prompt-send", { "prompt-send": [] }), [])
    assert.deepEqual(resolveHotkeyBindings("prompt-send", { "prompt-send": [{ key: "s", alt: true }] }, false), [{ key: "s", alt: true }])
    assert.deepEqual(resolveHotkeyBindings("session-tab-9", {}), [{ key: "9", mod: true, shift: true }])
    const defaults = resolveHotkeyBindings("new-instance", {})
    defaults[0].key = "changed"
    assert.equal(resolveHotkeyBindings("new-instance", {})[0].key, "n")
  })

  it("bounds and sanitizes persisted records without mutating input or disabling malformed actions", () => {
    const input = { unknown: [], "new-instance": [{ key: "N", mod: true, ctrl: false, garbage: true }, { key: "n", mod: true }],
      "close-instance": [{ key: "w", ctrl: "yes" }], "session-new": [], "prompt-send": null,
      "prompt-newline": Array(9).fill({ key: "Enter" }), "aside-send": [{ key: "x".repeat(41) }],
      "focus-input": [{ key: "Control" }] }
    const before = JSON.stringify(input)
    assert.deepEqual(normalizeHotkeyOverrides(input), { "new-instance": [{ key: "n", mod: true }], "session-new": [] })
    assert.equal(JSON.stringify(input), before)
    assert.deepEqual(normalizeHotkeyOverrides(Object.create({ "new-instance": [] })), {})
    for (const value of [null, [], "bad", 1]) assert.deepEqual(normalizeHotkeyOverrides(value), {})
  })

  it("keeps prototype-named keys as strings and rejects malformed keys at every boundary", () => {
    for (const key of ["constructor", "__proto__", "toString", "custom-key"]) {
      const input = JSON.parse(JSON.stringify({ "new-instance": [{ key, mod: true }] }))
      const normalized = normalizeHotkeyOverrides(input)
      assert.equal(normalized["new-instance"][0].key, key.toLowerCase())
      const binding = resolveHotkeyBindings("new-instance", normalized)[0]
      assert.equal(formatHotkeyBinding(binding, false), `Ctrl+${key.toUpperCase()}`)
      assert.equal(matchesHotkeyBinding(binding, event("n", { ctrlKey: true }), false), false)
      assert.ok(matchesHotkeyBinding(binding, event(key, { ctrlKey: true }), false))
      assert.doesNotThrow(() => findHotkeyConflicts(normalized, true, false))
    }
    for (const key of [undefined, null, 1, {}, [], Symbol("key")]) {
      const binding = { key, mod: true } as HotkeyBinding
      const input = { "new-instance": [binding] } as HotkeyOverrides
      assert.deepEqual(normalizeHotkeyOverrides(input), {})
      assert.deepEqual(resolveHotkeyBindings("new-instance", input), resolveHotkeyBindings("new-instance", {}))
      assert.equal(matchesHotkeyBinding(binding, event("n", { ctrlKey: true }), false), false)
      assert.equal(matchesHotkeyBinding({ key: "n" }, event(key as string)), false)
      assert.equal(formatHotkeyBinding(binding, false), "")
      assert.doesNotThrow(() => findHotkeyConflicts(input, true, false))
    }
  })
})

describe("exact hotkey matching and formatting", () => {
  it("resolves Mod for the platform and rejects every extra modifier", () => {
    assert.ok(matchesHotkeyBinding({ key: "n", mod: true }, event("N", { ctrlKey: true }), false))
    assert.ok(matchesHotkeyBinding({ key: "n", mod: true }, event("n", { metaKey: true }), true))
    assert.ok(!matchesHotkeyBinding({ key: "n", mod: true }, event("n", { ctrlKey: true }), true))
    for (const extra of [{ shiftKey: true }, { altKey: true }, { metaKey: true }]) {
      assert.ok(!matchesHotkeyBinding({ key: "n", mod: true }, event("n", { ctrlKey: true, ...extra }), false))
    }
    assert.ok(matchesHotkeyBinding({ key: "n", ctrl: true, meta: true }, event("n", { ctrlKey: true, metaKey: true }), true))
    assert.equal(formatHotkeyBinding({ key: "n", mod: true, shift: true }, false), "Ctrl+Shift+N")
    assert.equal(formatHotkeyBinding({ key: "n", mod: true, shift: true }, true), "⌘+⇧+N")
    assert.equal(formatHotkeyBinding({ key: "Escape" }, false), "Esc")
  })

  it("matches shifted brackets and digits using one physical identity, not physical letter positions", () => {
    assert.ok(matchesHotkeyBinding({ key: "[", mod: true, shift: true }, event("{", { code: "BracketLeft", ctrlKey: true, shiftKey: true }), false))
    assert.ok(matchesHotkeyBinding({ key: "]", mod: true, shift: true }, event("x", { code: "BracketRight", metaKey: true, shiftKey: true }), true))
    assert.ok(matchesHotkeyBinding({ key: "1", mod: true, shift: true }, event("!", { code: "Digit1", ctrlKey: true, shiftKey: true }), false))
    assert.ok(!matchesHotkeyBinding({ key: "n", mod: true }, event("m", { code: "KeyN", ctrlKey: true }), false))
    assert.ok(matchesHotkeyBinding({ key: "z", mod: true }, event("z", { code: "KeyY", ctrlKey: true }), false))
    assert.ok(!matchesHotkeyBinding({ key: "=", alt: true, shift: true }, event("+", { code: "Equal", altKey: true, shiftKey: true }), false))
    assert.ok(!matchesHotkeyBinding({ key: "1", mod: true }, event("1", { code: "Digit2", ctrlKey: true }), false))
    assert.ok(!matchesHotkeyBinding({ key: "[", mod: true }, event("[", { code: "BracketRight", ctrlKey: true }), false))
    assert.ok(!matchesHotkeyBinding({ key: "[", mod: true }, event("{", { code: "BracketLeft", ctrlKey: true, shiftKey: true }), false))
  })
})

describe("conflicts and deletion patches", () => {
  it("does not flag mutually exclusive home/main, composer/aside/search focus or Escape modes", () => {
    for (const mac of [false, true]) {
      assert.deepEqual(findHotkeyConflicts({}, true, mac), [])
      assert.deepEqual(findHotkeyConflicts({}, false, mac), [])
    }
    const result = findHotkeyConflicts({ "prompt-send": [{ key: "x" }], "aside-send": [{ key: "x" }],
      "search-next-result": [{ key: "x" }] })
    assert.deepEqual(result, [])
  })

  it("reports global/focused and same-scope overlaps, including Mod versus explicit Ctrl", () => {
    const input = { "focus-input": [{ key: "x" }], "prompt-send": [{ key: "x" }], "aside-send": [{ key: "x" }] }
    assert.deepEqual(findHotkeyConflicts(input, true, false), [{ ids: ["focus-input", "prompt-send", "aside-send"], binding: "X" }])
    assert.deepEqual(findHotkeyConflicts({ "instance-next": [{ key: "n", ctrl: true }] }, true, false),
      [{ ids: ["new-instance", "instance-next", "browse-folder"], binding: "Ctrl+N" }])
    assert.deepEqual(findHotkeyConflicts({ "instance-next": [{ key: "n", ctrl: true }] }, true, true), [])
    assert.deepEqual(findHotkeyConflicts({ "new-instance": [], "browse-folder": [], "instance-next": [{ key: "n", mod: true }] }), [])
  })

  it("canonicalizes stored digit and bracket aliases for conflict checks", () => {
    for (const [key, alias] of [["1", "Digit1"], ["{", "BracketLeft"], ["}", "BracketRight"]]) {
      const input = { "new-instance": [{ key, alt: true, shift: true }], "instance-next": [{ key: alias, alt: true, shift: true }] }
      assert.ok(findHotkeyConflicts(input, true, false).some(conflict => conflict.ids.includes("new-instance") && conflict.ids.includes("instance-next")))
    }
  })

  it("captures AZERTY digits, QWERTZ brackets and shifted digits with identical dispatch/conflict identities", () => {
    for (const mac of [false, true]) for (const [key, code, physical, other, shiftKey] of [
      ["&", "Digit1", "1", "app-tab-1", false], ["ü", "BracketLeft", "[", "instance-prev", false],
      ["!", "Digit1", "1", "session-tab-1", true],
    ] as const) {
      const keyEvent = event(key, { code, ctrlKey: !mac, metaKey: mac, shiftKey })
      const binding = { key: hotkeyEventKey(keyEvent), mod: true, ...(shiftKey ? { shift: true } : {}) }
      const input = normalizeHotkeyOverrides({ "focus-input": [binding] })
      const captured = resolveHotkeyBindings("focus-input", input)[0]
      assert.deepEqual(captured, { ...binding, key: physical })
      assert.ok(matchesHotkeyBinding(captured, keyEvent, mac))
      assert.ok(matchesHotkeyBinding(resolveHotkeyBindings(other, input)[0], keyEvent, mac))
      const conflicts = findHotkeyConflicts(input, true, mac)
      assert.equal(conflicts.length, 1)
      assert.deepEqual(new Set(conflicts[0].ids), new Set(["focus-input", other]))
      assert.equal(conflicts[0].binding, formatHotkeyBinding(captured, mac))
    }
  })

  it("keeps legacy layout symbols logical without guessing or silently migrating their physical slot", () => {
    for (const [key, code, other, shiftKey] of [
      ["&", "Digit1", "app-tab-1", false], ["ü", "BracketLeft", "instance-prev", false],
      ["!", "Digit1", "session-tab-1", true],
    ] as const) {
      const input = normalizeHotkeyOverrides({ "focus-input": [{ key, mod: true, ...(shiftKey ? { shift: true } : {}) }] })
      const legacy = resolveHotkeyBindings("focus-input", input)[0]
      assert.equal(legacy.key, key)
      const physical = event(key, { code, ctrlKey: true, shiftKey })
      assert.equal(matchesHotkeyBinding(legacy, physical, false), false, "re-record to bind this physical slot")
      assert.ok(matchesHotkeyBinding(resolveHotkeyBindings(other, input)[0], physical, false))
      assert.deepEqual(findHotkeyConflicts(input, true, false), [])
      assert.ok(matchesHotkeyBinding(legacy, event(key, { code: "Quote", ctrlKey: true, shiftKey }), false), "the logical symbol still works off reserved slots")
    }
    // Arbitrary code aliases previously allowed two identities for one event.
    for (const [key, code] of [["n", "KeyN"], ["+", "Equal"], ["1", "Numpad1"]]) {
      const input = { "new-instance": [{ key, alt: true }], "instance-next": [{ key: code, alt: true }] }
      const keyEvent = event(key, { code, altKey: true })
      assert.ok(matchesHotkeyBinding(input["new-instance"][0], keyEvent, false))
      assert.equal(matchesHotkeyBinding(input["instance-next"][0], keyEvent, false), false)
      assert.deepEqual(findHotkeyConflicts(input, true, false), [])
    }
  })

  it("uses null merge-patch deletion for one/all resets, and [] only for disabling", () => {
    assert.deepEqual(hotkeyOverridePatch("new-instance"), { settings: { hotkeyOverrides: { "new-instance": null } } })
    assert.deepEqual(hotkeyOverridePatch("new-instance", []), { settings: { hotkeyOverrides: { "new-instance": [] } } })
    assert.deepEqual(hotkeyOverridePatch("new-instance", [{ key: "X", alt: true }]),
      { settings: { hotkeyOverrides: { "new-instance": [{ key: "x", alt: true }] } } })
    assert.deepEqual(resetHotkeyOverridesPatch(), { settings: { hotkeyOverrides: null } })
    const owner = { settings: { unrelated: "kept", hotkeyOverrides: { "new-instance": [], "prompt-send": [{ key: "F9" }] } } }
    assert.deepEqual(applyMergePatch(owner, hotkeyOverridePatch("new-instance")), {
      settings: { unrelated: "kept", hotkeyOverrides: { "prompt-send": [{ key: "F9" }] } },
    })
    assert.deepEqual(applyMergePatch(owner, resetHotkeyOverridesPatch()), { settings: { unrelated: "kept" } })
    assert.throws(() => hotkeyOverridePatch("__proto__", []))
    assert.throws(() => hotkeyOverridePatch("new-instance", [{ key: "" }]))
  })
})
