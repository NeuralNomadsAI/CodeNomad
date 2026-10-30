import { isDeepStrictEqual } from "node:util"
import { findNodeAtLocation, parse, parseTree } from "jsonc-parser"
import type { SubagentNestingEffect } from "../api-types"
import type { PluginControlDocument } from "./plugin-control-document"
import {
  appendNativeSetting, readNativeSetting, removeEmptyNativeList, removeEmptyNativeObject, removeNativeListElement, withEditedText,
} from "./native-setting-document"

// OpenCode's built-in General subagent, which runs mission tasks unless a profile picks another agent,
// ships a rule denying `subagent`. That rule removes the tool, so whatever `experimental.subagent_depth`
// allows, General conversations never launch nested subagents until a later configuration rule allows it.
export const NESTING_AGENT = "general"
const AGENT = ["agents", NESTING_AGENT], RULES = [...AGENT, "permissions"]
const RULE = { action: "subagent", resource: "*", effect: "allow" }
/** Written inside the rule CodeNomad adds: only a rule carrying it is CodeNomad's to remove. */
const MARKER = "Added by CodeNomad with the subagent depth; Inherit removes it."
/** Nesting needs a child to launch its own child, which a depth of 2 first allows. */
export const NESTING_DEPTH = 2

type Rule = { action?: unknown; resource?: unknown; effect?: unknown }
type Entry = { type?: string; info?: { permissions?: unknown; agents?: Record<string, { permissions?: unknown } | undefined> } }

// OpenCode's whole-value wildcards: `*` any characters, `?` exactly one.
const special = /[.+^${}()|[\]\\]/g
const matches = (pattern: string, value: string) => {
  const source = pattern.replace(special, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  return new RegExp(`^${source}$`, "s").test(value)
}
const list = (value: unknown): Rule[] => Array.isArray(value) ? value : []

/** The effect of ordered permission rules on General launching General: the last matching rule wins. */
export function nestingEffect(rules: readonly Rule[]): SubagentNestingEffect | undefined {
  const rule = [...rules].reverse().find(rule => typeof rule?.action === "string" && typeof rule.resource === "string"
    && matches(rule.action, "subagent") && matches(rule.resource, NESTING_AGENT))
  return rule?.effect === "allow" || rule?.effect === "ask" || rule?.effect === "deny" ? rule.effect : undefined
}

/** General's rules from configuration documents in OpenCode's order (`entries` lowest priority first):
 * every document's top-level rules, then every document's General rules, all after the built-in ones. */
export function configuredNestingRules(entries: readonly unknown[]): Rule[] {
  const documents = (entries as Entry[]).filter(entry => entry?.type === "document")
  return [...documents.flatMap(entry => list(entry.info?.permissions)),
    ...documents.flatMap(entry => list(entry.info?.agents?.[NESTING_AGENT]?.permissions))]
}

/** The index of the rule CodeNomad added among the document's General rules, or -1. */
export function addedNestingRule(document: PluginControlDocument): number {
  try {
    if (!Array.isArray(readNativeSetting(document, RULES))) return -1
  } catch { return -1 }
  const rules = findNodeAtLocation(parseTree(document.text, [], { allowTrailingComma: true })!, RULES)!
  return rules.children!.findIndex(node => {
    const source = document.text.slice(node.offset, node.offset + node.length)
    return source.includes(MARKER) && isDeepStrictEqual(parse(source, [], { allowTrailingComma: true }), RULE)
  })
}

/** The text with CodeNomad's rule allowing General to launch subagents appended to its project rules. */
export function withNestingRule(document: PluginControlDocument): string {
  return appendNativeSetting(document, RULES, RULE, MARKER)
}

/** The text without CodeNomad's rule and the General containers it leaves empty; `undefined` without one. */
export function withoutNestingRule(document: PluginControlDocument): string | undefined {
  const index = addedNestingRule(document)
  const removed = index < 0 ? undefined : removeNativeListElement(document, RULES, index)
  if (removed === undefined) return undefined
  const prune: [string[], (document: PluginControlDocument, keys: string[]) => string | undefined][] =
    [[RULES, removeEmptyNativeList], [AGENT, removeEmptyNativeObject], [["agents"], removeEmptyNativeObject]]
  let text = removed
  for (const [keys, remove] of prune) {
    const pruned = remove(withEditedText(document, text), keys)
    if (pruned === undefined) break
    text = pruned
  }
  return text
}
