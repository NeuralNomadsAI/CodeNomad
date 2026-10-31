import assert from "node:assert/strict"
import test from "node:test"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import type { PluginControlDocument } from "./plugin-control-document"
import {
  addedNestingRule, nestingEffect, withNestingRule, withoutNestingRule,
} from "./subagent-nesting"

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

// General's rules as OpenCode's `agent.list` resolves them without configuration: the base policy,
// General's built-in rules, then rules a built-in plugin appends after configuration.
const base = [rule("*", "*", "allow"), rule("read", "*.env", "ask"), rule("read", "*.env.*", "ask"), rule("read", "*.env.example", "allow"),
  rule("question", "*", "deny"), rule("subagent", "*", "deny")]
const resolved = (...configured: ReturnType<typeof rule>[]) => [...base, ...configured, rule("browser", "*", "deny"), rule("skill", "browser", "deny")]

test("the last rule matching General launching General decides, with OpenCode's wildcard and the host's case rules", () => {
  assert.equal(nestingEffect(resolved(), false), "deny")
  assert.equal(nestingEffect(resolved(allow), false), "allow")
  assert.equal(nestingEffect(resolved(rule("*", "*", "allow")), false), "allow")
  assert.equal(nestingEffect(resolved(rule("sub*", "gen?ral", "ask")), false), "ask")
  assert.equal(nestingEffect(resolved(rule("subagent", "reviewer", "allow")), false), "deny")
  assert.equal(nestingEffect(resolved(rule("subagent.", "*", "allow")), false), "deny", "regular expression characters are literal")
  assert.equal(nestingEffect(resolved(rule("subagent", "general *", "allow")), false), "allow", "a trailing ` *` also matches without it")
  // A Windows host applies an uppercase denial after the allow; a Linux one ignores it.
  assert.equal(nestingEffect(resolved(allow, rule("SUBAGENT", "*", "deny")), true), "deny")
  assert.equal(nestingEffect(resolved(allow, rule("SUBAGENT", "*", "deny")), false), "allow")
  assert.equal(nestingEffect([], false), undefined)
  assert.equal(nestingEffect([{ action: "subagent", resource: "*", effect: "maybe" }, { action: 1 }], false), undefined)
})

test("the added rule carries its marker, keeps the document and is the only one Inherit removes", () => {
  const original = `${bom}{\r\n\t// keep\r\n\t"agents": {\r\n\t\t"general": {\r\n\t\t\t"permissions": [\r\n\t\t\t\t{ "action": "edit", "resource": "*", "effect": "ask" }\r\n\t\t\t]\r\n\t\t}\r\n\t}\r\n}\r\n`
  const source = document(original.slice(1), true)
  assert.equal(addedNestingRule(source), -1)
  const added = withNestingRule(source)
  assert.ok(added.startsWith(bom) && !added.slice(1).startsWith(bom))
  assert.ok(!/[^\r]\n/.test(added), "CRLF kept")
  assert.match(added, /\t\/\/ keep/)
  assert.match(added, /\t+\/\/ Added by CodeNomad with the project subagent depth; Inherit removes it\.\r\n\t+"action": "subagent"/)
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
