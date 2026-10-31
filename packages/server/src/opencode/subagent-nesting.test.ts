import assert from "node:assert/strict"
import test from "node:test"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import type { PluginControlDocument } from "./plugin-control-document"
import {
  hasNestingRule, nestingEffect, nestingToolHidden, withNestingRule, withoutNestingRule,
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

test("OpenCode hides General's subagent tool only when its last subagent rule denies every target", () => {
  assert.equal(nestingToolHidden(resolved(), false), true)
  assert.equal(nestingToolHidden(resolved(allow), false), false)
  // General may not launch General, but may launch others: the tool stays (the mixed-target case).
  assert.equal(nestingToolHidden(resolved(allow, rule("subagent", "general", "deny")), false), false)
  assert.equal(nestingEffect(resolved(allow, rule("subagent", "general", "deny")), false), "deny")
  assert.equal(nestingToolHidden(resolved(rule("subagent", "reviewer", "allow")), false), false)
  assert.equal(nestingToolHidden(resolved(allow, rule("*", "*", "deny")), false), true)
  assert.equal(nestingToolHidden(resolved(allow, rule("SUBAGENT", "*", "deny")), true), true)
  assert.equal(nestingToolHidden(resolved(allow, rule("SUBAGENT", "*", "deny")), false), false)
  assert.equal(nestingToolHidden([], false), false)
})

test("the added rule carries its marker, keeps the document and is the only one Inherit removes", () => {
  const original = `${bom}{\r\n\t// keep\r\n\t"agents": {\r\n\t\t"general": {\r\n\t\t\t"permissions": [\r\n\t\t\t\t{ "action": "edit", "resource": "*", "effect": "ask" }\r\n\t\t\t]\r\n\t\t}\r\n\t}\r\n}\r\n`
  const source = document(original.slice(1), true)
  assert.equal(hasNestingRule(source), false)
  const added = withNestingRule(source)!
  assert.ok(added.startsWith(bom) && !added.slice(1).startsWith(bom))
  assert.ok(!/[^\r]\n/.test(added), "CRLF kept")
  assert.match(added, /\t\/\/ keep/)
  assert.match(added, /\t+\/\/ Added by CodeNomad with the project subagent depth; Inherit removes it\.\r\n\t+"action": "subagent"/)
  assert.deepEqual(parse(added).agents.general.permissions, [rule("edit", "*", "ask"), allow])
  const withRule = document(added.slice(1), true)
  assert.equal(hasNestingRule(withRule), true)
  assert.equal(withoutNestingRule(withRule), original, "removal restores the original text")

  // An identical rule without the marker, or a marked rule the user changed, is the user's.
  for (const text of [`{ "agents": { "general": { "permissions": [{ "action": "subagent", "resource": "*", "effect": "allow" }] } } }`,
    added.slice(1).replace('"allow"', '"deny"')]) {
    assert.equal(hasNestingRule(document(text)), false)
    assert.equal(withoutNestingRule(document(text)), undefined)
  }
})

test("removal prunes only the containers the added rule leaves empty", () => {
  const fresh = withNestingRule(document(`{\n  "shell": "keep"\n}\n`))!
  assert.deepEqual(parse(fresh), { shell: "keep", agents: { general: { permissions: [allow] } } })
  assert.deepEqual(parse(withoutNestingRule(document(fresh))!), { shell: "keep" })
  const shared = withNestingRule(document(`{ "agents": { "build": { "mode": "primary" }, "general": { "steps": 4 } } }`))!
  assert.deepEqual(parse(withoutNestingRule(document(shared))!), { agents: { build: { mode: "primary" }, general: { steps: 4 } } })
  const compact = withNestingRule(document(`{"agents":{"general":{"permissions":[]}}}`))!
  assert.match(compact, /\/\/ Added by CodeNomad|\/\* Added by CodeNomad/)
  assert.equal(hasNestingRule(document(compact)), true)
  assert.deepEqual(parse(withoutNestingRule(document(compact))!), {})
})

test("unreadable rule locations are never treated as CodeNomad's", () => {
  for (const text of [`{ "agents": [] }`, `{ "agents": { "general": { "permissions": {} } } }`,
    `{ "agents": { "general": {}, "general": {} } }`, `{`])
    assert.equal(hasNestingRule(document(text)), false, text)
  assert.throws(() => withNestingRule(document(`{ "agents": { "general": { "permissions": {} } } }`)), /list/)
})

test("a legacy General block takes the rule as a permission property, never shadowed by a new native block", () => {
  const original = [`{`, `  // mine`, `  "agent": {`, `    "general": {`, `      "description": "USER_GENERAL",`, `      "prompt": "USER_PROMPT",`,
    `      "maxSteps": 7,`, `      "permission": {`, `        "edit": "deny",`, `        "bash": "deny",`, `        "task": "deny"`, `      }`, `    }`, `  }`, `}`, ``].join("\n")
  const added = withNestingRule(document(original))!
  const value = parse(added)
  assert.equal(value.agents, undefined, "no native General block that would replace the legacy one")
  assert.deepEqual(value.agent.general.permission, { edit: "deny", bash: "deny", task: "deny", subagent: { "*": "allow" } },
    "a key OpenCode reads after the user's \`task\`, so the rule comes last")
  assert.equal(value.agent.general.prompt, "USER_PROMPT")
  assert.match(added, /"task": "deny",\n        "subagent": \{\n          \/\/ Added by CodeNomad/)
  assert.equal(hasNestingRule(document(added)), true)
  assert.equal(withoutNestingRule(document(added)), original, "removal restores the original text")

  // Keys a legacy \`tools\` or \`permission\` entry already holds would place the rule earlier: the free one is used.
  const subagentTaken = withNestingRule(document(`{ "agent": { "general": { "tools": { "subagent": false } } } }`))!
  assert.deepEqual(parse(subagentTaken).agent.general, { tools: { subagent: false }, permission: { task: { "*": "allow" } } })
  assert.deepEqual(parse(withoutNestingRule(document(subagentTaken))!), { agent: { general: { tools: { subagent: false } } } },
    "only the permission object CodeNomad created goes")
  for (const text of [`{ "agent": { "general": { "tools": { "task": false }, "permission": { "subagent": "deny" } } } }`,
    `{ "agent": { "general": { "permission": "deny" } } }`])
    assert.equal(withNestingRule(document(text)), undefined, `no rule without rewriting the user's value: ${text}`)

  // Within one document a native entry replaces a legacy \`mode\` one, which replaces \`agent\`: the winner takes it.
  const both = `{ "agent": { "general": { "steps": 3 } }, "agents": { "general": { "steps": 5 } } }`
  assert.deepEqual(parse(withNestingRule(document(both))!).agents.general.permissions, [allow])
  const mode = withNestingRule(document(`{ "agent": { "general": { "steps": 3 } }, "mode": { "general": { "steps": 5 } } }`))!
  assert.deepEqual(parse(mode), { agent: { general: { steps: 3 } }, mode: { general: { steps: 5, permission: { subagent: { "*": "allow" } } } } })
  assert.deepEqual(parse(withoutNestingRule(document(mode))!), { agent: { general: { steps: 3 } }, mode: { general: { steps: 5 } } })
  // A legacy rule the user changed is the user's.
  assert.equal(hasNestingRule(document(added.replace('"*": "allow"', '"*": "ask"'))), false)
})
