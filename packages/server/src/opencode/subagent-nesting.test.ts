import assert from "node:assert/strict"
import test from "node:test"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import type { PluginControlDocument } from "./plugin-control-document"
import { addedNestingRule, configuredNestingRules, nestingEffect, withNestingRule, withoutNestingRule } from "./subagent-nesting"

const bom = String.fromCharCode(0xfeff)
const document = (text: string, byteOrderMark = false) => ({ text, byteOrderMark }) as PluginControlDocument
function parse(text: string) {
  const errors: ParseError[] = []
  const value = parseJsonc(text.replace(/^﻿/, ""), errors, { allowTrailingComma: true })
  assert.deepEqual(errors, [], text)
  return value
}
const rule = (action: string, resource: string, effect: string) => ({ action, resource, effect })
const allow = rule("subagent", "*", "allow")

test("the last rule matching General launching General decides, with OpenCode's wildcards", () => {
  // OpenCode's resolved General rules: base policy, then its built-in denial.
  const builtIn = [rule("*", "*", "allow"), rule("question", "*", "deny"), rule("subagent", "*", "deny")]
  assert.equal(nestingEffect(builtIn), "deny")
  assert.equal(nestingEffect([...builtIn, allow]), "allow")
  assert.equal(nestingEffect([...builtIn, rule("*", "*", "allow")]), "allow")
  assert.equal(nestingEffect([...builtIn, rule("sub*", "gen?ral", "ask")]), "ask")
  assert.equal(nestingEffect([...builtIn, rule("subagent", "reviewer", "allow"), rule("shell", "*", "allow")]), "deny")
  assert.equal(nestingEffect([...builtIn, rule("subagent.", "*", "allow")]), "deny", "regular expression characters are literal")
  assert.equal(nestingEffect([]), undefined)
  assert.equal(nestingEffect([{ action: "subagent", resource: "*", effect: "maybe" }, { action: 1 }]), undefined)
})

test("configured rules follow OpenCode's order: every top-level rule, then every General rule", () => {
  const entries = [
    { type: "directory", path: "/global" },
    { type: "document", path: "/global/opencode.jsonc", info: { agents: { general: { permissions: [rule("subagent", "*", "ask")] } } } },
    { type: "document", path: "/project/opencode.jsonc", info: { permissions: [allow], agents: { build: { permissions: [rule("subagent", "*", "deny")] } } } },
  ]
  assert.deepEqual(configuredNestingRules(entries), [allow, rule("subagent", "*", "ask")])
  assert.equal(nestingEffect(configuredNestingRules(entries)), "ask", "a General rule outranks any top-level rule")
  assert.deepEqual(configuredNestingRules([{ type: "document", info: { permissions: "invalid", agents: { general: null } } }]), [])
})

test("the added rule carries its marker, keeps the document and is the only one Inherit removes", () => {
  const original = `${bom}{\r\n\t// keep\r\n\t"agents": {\r\n\t\t"general": {\r\n\t\t\t"permissions": [\r\n\t\t\t\t{ "action": "edit", "resource": "*", "effect": "ask" }\r\n\t\t\t]\r\n\t\t}\r\n\t}\r\n}\r\n`
  const source = document(original.slice(1), true)
  assert.equal(addedNestingRule(source), -1)
  const added = withNestingRule(source)
  assert.ok(added.startsWith(bom) && !added.slice(1).startsWith(bom))
  assert.ok(!/[^\r]\n/.test(added), "CRLF kept")
  assert.match(added, /\t\/\/ keep/)
  assert.match(added, /\t+\/\/ Added by CodeNomad with the subagent depth; Inherit removes it\.\r\n\t+"action": "subagent"/)
  assert.deepEqual(parse(added).agents.general.permissions, [rule("edit", "*", "ask"), allow])
  const withRule = document(added.slice(1), true)
  assert.equal(addedNestingRule(withRule), 1)
  assert.equal(withoutNestingRule(withRule), original, "removal restores the original text")

  // An identical rule without the marker, or a marked rule the user changed, is the user's.
  for (const text of [`{ "agents": { "general": { "permissions": [{ "action": "subagent", "resource": "*", "effect": "allow" }] } } }`,
    added.slice(1).replace('"allow"', '"deny"')]) {
    assert.equal(addedNestingRule(document(text)), -1)
    assert.equal(withoutNestingRule(document(text)), undefined)
  }
})

test("removal prunes only the containers the added rule leaves empty", () => {
  const fresh = withNestingRule(document(`{\n  "shell": "keep"\n}\n`))
  assert.deepEqual(parse(fresh), { shell: "keep", agents: { general: { permissions: [allow] } } })
  assert.deepEqual(parse(withoutNestingRule(document(fresh))!), { shell: "keep" })
  const shared = withNestingRule(document(`{ "agents": { "build": { "mode": "primary" }, "general": { "steps": 4 } } }`))
  assert.deepEqual(parse(withoutNestingRule(document(shared))!), { agents: { build: { mode: "primary" }, general: { steps: 4 } } })
  const compact = withNestingRule(document(`{"agents":{"general":{"permissions":[]}}}`))
  assert.match(compact, /\/\/ Added by CodeNomad|\/\* Added by CodeNomad/)
  assert.equal(addedNestingRule(document(compact)), 0)
  assert.deepEqual(parse(withoutNestingRule(document(compact))!), {})
})

test("unreadable rule locations are never treated as CodeNomad's", () => {
  for (const text of [`{ "agents": [] }`, `{ "agents": { "general": { "permissions": {} } } }`,
    `{ "agents": { "general": {}, "general": {} } }`, `{`])
    assert.equal(addedNestingRule(document(text)), -1, text)
  assert.throws(() => withNestingRule(document(`{ "agents": { "general": { "permissions": {} } } }`)), /list/)
})
