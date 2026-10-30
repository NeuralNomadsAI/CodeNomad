import { isDeepStrictEqual } from "node:util"
import { findNodeAtLocation, parse, parseTree, type ParseError } from "jsonc-parser"
import type { SubagentNestingEffect } from "../api-types"
import type { PluginControlDocument } from "./plugin-control-document"
import {
  appendNativeSetting, readNativeSetting, removeEmptyNativeList, removeEmptyNativeObject, removeNativeListElement, withEditedText,
} from "./native-setting-document"

// OpenCode's built-in General subagent, which runs mission tasks unless a profile picks another agent,
// ships a rule denying `subagent`. That rule removes the tool, so whatever `experimental.subagent_depth`
// allows, General conversations never launch nested subagents until a later rule allows it.
export const NESTING_AGENT = "general"
const AGENT = ["agents", NESTING_AGENT], RULES = [...AGENT, "permissions"]
const RULE = { action: "subagent", resource: "*", effect: "allow" }
/** Every agent's base policy, then General's built-in denial, as `agent.list` resolves them. */
const BASE = { action: "*", resource: "*", effect: "allow" }, BUILT_IN = { action: "subagent", resource: "*", effect: "deny" }
/** Written inside the rule CodeNomad adds: only a rule carrying it is CodeNomad's to remove. */
const MARKER = "Added by CodeNomad with the subagent depth; Inherit removes it."
/** Nesting needs a child to launch its own child, which a depth of 2 first allows. */
export const NESTING_DEPTH = 2

export type Rule = { action?: unknown; resource?: unknown; effect?: unknown }
type Entry = { type?: string; path?: string; info?: Record<string, any> }

// OpenCode's whole-value wildcard (core `util/wildcard.ts`): backslashes read as slashes, `*` any
// characters, `?` one, a pattern ending in " *" also matching without that suffix, case-insensitive on
// Windows hosts.
const special = /[.+^${}()|[\]\\]/g
export function wildcardMatch(value: string, pattern: string, ignoreCase: boolean): boolean {
  let source = pattern.replaceAll("\\", "/").replace(special, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`
  return new RegExp(`^${source}$`, ignoreCase ? "si" : "s").test(value.replaceAll("\\", "/"))
}
const list = (value: unknown): Rule[] => Array.isArray(value) ? value : []
const pick = (rule: Rule) => ({ action: rule?.action, resource: rule?.resource, effect: rule?.effect })
/** Rules that can decide `subagent` on any host, whatever agent they target, in order. */
const subagentRules = (rules: readonly Rule[]) => rules.filter(rule =>
  typeof rule?.action === "string" && wildcardMatch("subagent", rule.action, true)).map(pick)

/** The effect of ordered permission rules on General launching General: the last matching rule wins. */
export function nestingEffect(rules: readonly Rule[], ignoreCase: boolean): SubagentNestingEffect | undefined {
  const rule = [...rules].reverse().find(rule => typeof rule?.action === "string" && typeof rule.resource === "string"
    && wildcardMatch("subagent", rule.action, ignoreCase) && wildcardMatch(NESTING_AGENT, rule.resource, ignoreCase))
  return rule?.effect === "allow" || rule?.effect === "ask" || rule?.effect === "deny" ? rule.effect : undefined
}

/** Whether General's resolved rules (from `agent.list`, so every configuration format, scope and agent
 * file counts) hold no `subagent` rule besides the base policy, the built-in denial and CodeNomad's own
 * rule (`added`), or one identical allow. Only then does CodeNomad's allow neutralize exactly the built-in
 * denial: any other rule, for any target, matched case-insensitively, keeps every permission unchanged. */
export function builtInNesting(rules: readonly Rule[], added: boolean): boolean {
  const relevant = subagentRules(rules)
  if (added) for (let index = relevant.length - 1; index >= 0; index--)
    if (isDeepStrictEqual(relevant[index], RULE)) { relevant.splice(index, 1); break }
  return [[BASE, BUILT_IN], [BASE, BUILT_IN, RULE]].some(expected => isDeepStrictEqual(relevant, expected))
}

/** The `subagent` rules a configuration document gives every agent and General; `undefined` when it uses
 * a format whose rules cannot be compared with OpenCode's normalized entries. */
function documentRules(info: Record<string, any> | undefined, project: boolean) {
  const own = info?.agents?.[NESTING_AGENT]
  if ([info?.permission, info?.tools, info?.agent?.[NESTING_AGENT], own?.permission, own?.tools].some(value => value !== undefined))
    return undefined
  const general = subagentRules(list(own?.permissions))
  // CodeNomad's own rule may be written but not yet loaded, or removed but still loaded.
  return { all: subagentRules(list(info?.permissions)), general: project ? general.filter(rule => !isDeepStrictEqual(rule, RULE)) : general }
}

/** Whether OpenCode has loaded the `subagent` rules of each fresh owned document (`entries` are the native
 * configuration documents): native entries lag behind writes, so a mismatch makes every reading uncertain. */
export function nestingRulesLoaded(documents: readonly { scope: string; path: string; document: PluginControlDocument }[],
  entries: readonly unknown[], samePath: (left: string, right: string) => boolean): boolean {
  return documents.every(({ scope, path, document }) => {
    const errors: ParseError[] = []
    const fresh = document.exists ? parse(document.text, errors, { allowTrailingComma: true }) : {}
    const entry = (entries as Entry[]).find(entry => entry?.type === "document" && entry.path !== undefined && samePath(entry.path, path))
    const [owned, loaded] = [documentRules(fresh, scope === "project"), documentRules(entry?.info, scope === "project")]
    return errors.length === 0 && owned !== undefined && loaded !== undefined && isDeepStrictEqual(owned, loaded)
  })
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
