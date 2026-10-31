import { isDeepStrictEqual } from "node:util"
import { findNodeAtLocation, parse, parseTree } from "jsonc-parser"
import type { SubagentNestingEffect } from "../api-types"
import type { PluginControlDocument } from "./plugin-control-document"
import {
  appendNativeSetting, readNativeSetting, removeEmptyNativeList, removeEmptyNativeObject, removeNativeListElement, withEditedText,
} from "./native-setting-document"

// OpenCode's built-in General subagent, which runs mission tasks unless a profile picks another agent,
// ships a rule denying `subagent`. That rule removes the tool, so whatever `experimental.subagent_depth`
// allows, General conversations never launch nested subagents until a later rule allows it. A project depth
// override writes CodeNomad's allow in the project document, which outranks General rules from other documents.
export const NESTING_AGENT = "general"
const AGENT = ["agents", NESTING_AGENT], RULES = [...AGENT, "permissions"]
const RULE = { action: "subagent", resource: "*", effect: "allow" }
/** Written inside the rule CodeNomad adds: only a rule carrying it is CodeNomad's to remove. */
const MARKER = "Added by CodeNomad with the project subagent depth; Inherit removes it."

type Rule = { action?: unknown; resource?: unknown; effect?: unknown }

// For display only. OpenCode's whole-value wildcard: backslashes read as slashes, `*` any characters, `?` one,
// a pattern ending in " *" also matching without that suffix, case-insensitive on Windows hosts.
const special = /[.+^${}()|[\]\\]/g
function wildcardMatch(value: string, pattern: string, ignoreCase: boolean): boolean {
  let source = pattern.replaceAll("\\", "/").replace(special, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`
  return new RegExp(`^${source}$`, ignoreCase ? "si" : "s").test(value.replaceAll("\\", "/"))
}

/** The effect of General's resolved rules (`agent.list`) on General launching General: the last matching rule wins. */
export function nestingEffect(rules: readonly Rule[], ignoreCase: boolean): SubagentNestingEffect | undefined {
  const rule = [...rules].reverse().find(rule => typeof rule?.action === "string" && typeof rule.resource === "string"
    && wildcardMatch("subagent", rule.action, ignoreCase) && wildcardMatch(NESTING_AGENT, rule.resource, ignoreCase))
  return rule?.effect === "allow" || rule?.effect === "ask" || rule?.effect === "deny" ? rule.effect : undefined
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
