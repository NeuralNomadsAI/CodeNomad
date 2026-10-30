import assert from "node:assert/strict"
import test from "node:test"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import type { PluginControlDocument } from "./plugin-control-document"
import {
  addedNestingRule, builtInNesting, nestingEffect, nestingRulesLoaded, wildcardMatch, withNestingRule, withoutNestingRule,
} from "./subagent-nesting"
import { samePath } from "./experimental-layers"

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

// General's rules as OpenCode 2.2.3's `agent.list` resolves them without configuration: the base policy,
// General's built-in rules, then rules a built-in plugin appends after configuration.
const base = [rule("*", "*", "allow"), rule("read", "*.env", "ask"), rule("read", "*.env.*", "ask"), rule("read", "*.env.example", "allow"),
  rule("question", "*", "deny"), rule("subagent", "*", "deny")]
const resolved = (...configured: ReturnType<typeof rule>[]) => [...base, ...configured, rule("browser", "*", "deny"), rule("skill", "browser", "deny")]

test("OpenCode's wildcard: slashes for backslashes, a trailing ` *` and case-insensitivity on Windows hosts only", () => {
  assert.equal(wildcardMatch("subagent", "SUBAGENT", true), true)
  assert.equal(wildcardMatch("subagent", "SUBAGENT", false), false)
  assert.equal(wildcardMatch("a\\b", "a/*", false), true)
  assert.equal(wildcardMatch("git status", "git status *", false), true)
  assert.equal(wildcardMatch("subagent", "sub?gent", false), true)
  assert.equal(wildcardMatch("subagentX", "subagent.", false), false, "regular expression characters are literal")
})

test("the last rule matching General launching General decides, with the host's case rules", () => {
  assert.equal(nestingEffect(resolved(), false), "deny")
  assert.equal(nestingEffect(resolved(allow), false), "allow")
  assert.equal(nestingEffect(resolved(rule("*", "*", "allow")), false), "allow")
  assert.equal(nestingEffect(resolved(rule("sub*", "gen?ral", "ask")), false), "ask")
  assert.equal(nestingEffect(resolved(rule("subagent", "reviewer", "allow")), false), "deny")
  // A Windows host applies an uppercase denial after the allow; a Linux one ignores it.
  assert.equal(nestingEffect(resolved(allow, rule("SUBAGENT", "*", "deny")), true), "deny")
  assert.equal(nestingEffect(resolved(allow, rule("SUBAGENT", "*", "deny")), false), "allow")
  assert.equal(nestingEffect([], false), undefined)
  assert.equal(nestingEffect([{ action: "subagent", resource: "*", effect: "maybe" }, { action: 1 }], false), undefined)
})

test("only OpenCode's built-in denial, alone, is CodeNomad's to neutralize", () => {
  assert.equal(builtInNesting(resolved(), false), true)
  assert.equal(builtInNesting(resolved(allow), true), true, "CodeNomad's own loaded rule")
  assert.equal(builtInNesting(resolved(), true), true, "CodeNomad's rule written but not loaded yet")
  assert.equal(builtInNesting(resolved(allow), false), true, "an identical allow, or CodeNomad's removed rule still loaded")
  assert.equal(builtInNesting(resolved(allow, allow), true), true, "a user's identical allow beside CodeNomad's")
  for (const configured of [
    // Restrictions and exceptions for other targets, top-level or General-specific (finding: blanket over narrow rules).
    rule("subagent", "reviewer", "deny"), rule("subagent", "reviewer", "ask"), rule("subagent", "reviewer", "allow"),
    // A Markdown `agents/general.md` denial resolves to a second identical denial.
    rule("subagent", "*", "deny"),
    // Uppercase or wildcard actions decide `subagent` on Windows hosts.
    rule("SUBAGENT", "*", "deny"), rule("Sub*", "*", "ask"), rule("*", "*", "deny"), rule("*", "*", "allow"),
  ]) {
    assert.equal(builtInNesting(resolved(configured), false), false, JSON.stringify(configured))
    assert.equal(builtInNesting(resolved(allow, configured), true), false, `after CodeNomad's rule: ${JSON.stringify(configured)}`)
  }
  assert.equal(builtInNesting(resolved(allow, allow), false), false, "two allows without CodeNomad's rule are not the built-in policy")
  assert.equal(builtInNesting(base.slice(0, -1), false), false, "without the built-in denial there is nothing to neutralize")
})

test("rules count as loaded only when native entries match the fresh owned documents", () => {
  const owned = (scope: string, path: string, text?: string) =>
    ({ scope, path, document: { text: text ?? "", exists: text !== undefined, byteOrderMark: false } as PluginControlDocument })
  const entry = (path: string, info: unknown) => ({ type: "document", path, info })
  const deny = rule("subagent", "*", "deny")
  const global = '{ "agents": { "general": { "permissions": [{ "action": "subagent", "resource": "*", "effect": "deny" }] } } }'
  const loaded = (documents: ReturnType<typeof owned>[], entries: unknown[]) => nestingRulesLoaded(documents, entries, samePath)
  assert.equal(loaded([owned("global", "/g/opencode.jsonc"), owned("project", "/p/opencode.jsonc", "{}")], []), true)
  assert.equal(loaded([owned("global", "/g/opencode.jsonc", global)], [entry("/g/opencode.jsonc", { agents: { general: { permissions: [deny] } } })]), true)
  assert.equal(loaded([owned("global", "/g/opencode.jsonc", global)], [entry("/g/opencode.jsonc", {})]), false, "a denial not loaded yet")
  assert.equal(loaded([owned("global", "/g/opencode.jsonc", "{}")], [entry("/g/opencode.jsonc", { permissions: [deny] })]), false, "a removed denial still loaded")
  assert.equal(loaded([owned("global", "C:\\G\\opencode.jsonc", '{ "permissions": [] }')], [entry("c:\\g\\OPENCODE.jsonc", { permissions: [] })]), true)
  // CodeNomad's own rule may be in flight in the project document only.
  const project = withNestingRule(document("{}"))
  assert.equal(loaded([owned("project", "/p/opencode.jsonc", project)], [entry("/p/opencode.jsonc", {})]), true)
  assert.equal(loaded([owned("global", "/g/opencode.jsonc", project)], [entry("/g/opencode.jsonc", {})]), false)
  // Formats whose rules cannot be compared with normalized entries are uncertain.
  for (const text of ['{ "permission": { "task": "allow" } }', '{ "tools": { "task": false } }', '{ "agent": { "general": {} } }',
    '{ "agents": { "general": { "tools": { "task": false } } } }', '{ "permissions": [', '{ "agents": { "general": { "permission": {} } } }'])
    assert.equal(loaded([owned("global", "/g/opencode.jsonc", text)], [entry("/g/opencode.jsonc", {})]), false, text)
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
