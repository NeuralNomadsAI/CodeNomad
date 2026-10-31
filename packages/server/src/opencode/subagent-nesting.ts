import { isDeepStrictEqual } from "node:util"
import { findNodeAtLocation, parse, parseTree } from "jsonc-parser"
import type { SubagentNestingEffect } from "../api-types"
import type { PluginControlDocument } from "./plugin-control-document"
import {
  appendNativeProperty, appendNativeSetting, readNativeSetting, removeEmptyNativeList, removeEmptyNativeObject, removeNativeListElement,
  removeNativeProperty, withEditedText,
} from "./native-setting-document"

// OpenCode's built-in General subagent, which runs mission tasks unless a profile picks another agent,
// ships a rule denying `subagent`. That rule removes the tool, so whatever `experimental.subagent_depth`
// allows, General conversations never launch nested subagents until a later rule allows it. A project depth
// override writes CodeNomad's allow in the project document, which outranks General rules from other documents.
export const NESTING_AGENT = "general"
const RULE = { action: "subagent", resource: "*", effect: "allow" }
/** The same rule in a legacy agent's `permission` object: every target allowed. */
const LEGACY_RULE = { "*": "allow" }
/** Legacy permission keys OpenCode reads as the `subagent` action. */
const LEGACY_KEYS = ["subagent", "task"]
/** Written inside the rule CodeNomad adds: only a rule carrying it is CodeNomad's to remove. */
const MARKER = "Added by CodeNomad with the project subagent depth; Inherit removes it."

/** Where one document can define General, in the order OpenCode lets them win within it (`config/normalize.ts`):
 * a native `agents` entry replaces the whole migrated legacy entry, and a legacy `mode` entry replaces `agent`. */
const LOCATIONS = [
  { keys: ["agents", NESTING_AGENT], legacy: false },
  { keys: ["mode", NESTING_AGENT], legacy: true },
  { keys: ["agent", NESTING_AGENT], legacy: true },
] as const

type Rule = { action?: unknown; resource?: unknown; effect?: unknown }

// For display only. OpenCode's whole-value wildcard: backslashes read as slashes, `*` any characters, `?` one,
// a pattern ending in " *" also matching without that suffix, case-insensitive on Windows hosts.
const special = /[.+^${}()|[\]\\]/g
function wildcardMatch(value: string, pattern: string, ignoreCase: boolean): boolean {
  let source = pattern.replaceAll("\\", "/").replace(special, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`
  return new RegExp(`^${source}$`, ignoreCase ? "si" : "s").test(value.replaceAll("\\", "/"))
}
const subagentAction = (rule: Rule, ignoreCase: boolean) =>
  typeof rule?.action === "string" && wildcardMatch("subagent", rule.action, ignoreCase)

/** The effect of General's resolved rules (`agent.list`) on General launching General: the last matching rule wins. */
export function nestingEffect(rules: readonly Rule[], ignoreCase: boolean): SubagentNestingEffect | undefined {
  const rule = [...rules].reverse().find(rule => subagentAction(rule, ignoreCase) && typeof rule.resource === "string"
    && wildcardMatch(NESTING_AGENT, rule.resource, ignoreCase))
  return rule?.effect === "allow" || rule?.effect === "ask" || rule?.effect === "deny" ? rule.effect : undefined
}

/** Whether OpenCode removes the subagent tool from General: its last rule for the action denies every target
 * (core `tool.ts` `whollyDisabled`). */
export function nestingToolHidden(rules: readonly Rule[], ignoreCase: boolean): boolean {
  const rule = [...rules].reverse().find(rule => subagentAction(rule, ignoreCase))
  return rule?.resource === "*" && rule.effect === "deny"
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const marked = (document: PluginControlDocument, keys: (string | number)[], rule: unknown) => {
  const node = findNodeAtLocation(parseTree(document.text, [], { allowTrailingComma: true })!, keys)
  const source = node ? document.text.slice(node.offset, node.offset + node.length) : ""
  return source.includes(MARKER) && isDeepStrictEqual(parse(source, [], { allowTrailingComma: true }), rule)
}

/** The path of the rule CodeNomad added in any General block of the document. */
function findNestingRule(document: PluginControlDocument): (string | number)[] | undefined {
  for (const { keys, legacy } of LOCATIONS) {
    try {
      if (!legacy) {
        const rules = readNativeSetting(document, [...keys, "permissions"])
        const index = Array.isArray(rules) ? rules.findIndex((_, index) => marked(document, [...keys, "permissions", index], RULE)) : -1
        if (index >= 0) return [...keys, "permissions", index]
        continue
      }
      const permission = readNativeSetting(document, [...keys, "permission"])
      const name = object(permission) ? LEGACY_KEYS.find(key => marked(document, [...keys, "permission", key], LEGACY_RULE)) : undefined
      if (name) return [...keys, "permission", name]
    } catch { continue }
  }
  return undefined
}

export function hasNestingRule(document: PluginControlDocument): boolean {
  return findNestingRule(document) !== undefined
}

/** The text with CodeNomad's rule allowing General to launch subagents, in the General block the document
 * already uses, so no new block replaces it: native rules last in `agents.general.permissions`, or a legacy
 * `permission` property (`subagent`, else `task`) that no earlier `tools` or `permission` key holds, so it
 * stays last. `undefined` when that needs rewriting the user's own value (a string `permission`, both keys
 * taken). */
export function withNestingRule(document: PluginControlDocument): string | undefined {
  const { keys, legacy } = LOCATIONS.find(location => readNativeSetting(document, [...location.keys]) !== undefined) ?? LOCATIONS[0]
  if (!legacy) return appendNativeSetting(document, [...keys, "permissions"], RULE, MARKER)
  const permission = readNativeSetting(document, [...keys, "permission"]), tools = readNativeSetting(document, [...keys, "tools"])
  if (permission !== undefined && !object(permission)) return undefined
  const taken = new Set([...Object.keys(permission ?? {}), ...Object.keys(object(tools) ? tools : {})])
  const name = LEGACY_KEYS.find(key => !taken.has(key))
  return name === undefined ? undefined : appendNativeProperty(document, [...keys, "permission"], name, LEGACY_RULE, MARKER)
}

/** The text without CodeNomad's rule and the containers it leaves empty; `undefined` without one. */
export function withoutNestingRule(document: PluginControlDocument): string | undefined {
  const path = findNestingRule(document)
  if (!path) return undefined
  const container = path.slice(0, 3) as string[], member = path[3]
  const native = typeof member === "number"
  const removed = native ? removeNativeListElement(document, container, member) : removeNativeProperty(document, [...container, member])
  if (removed === undefined) return undefined
  // A legacy General block is the user's: only the permission object CodeNomad may have created goes.
  const prune: [string[], (document: PluginControlDocument, keys: string[]) => string | undefined][] = native
    ? [[container, removeEmptyNativeList], [["agents", NESTING_AGENT], removeEmptyNativeObject], [["agents"], removeEmptyNativeObject]]
    : [[container, removeEmptyNativeObject]]
  let text = removed
  for (const [keys, remove] of prune) {
    const pruned = remove(withEditedText(document, text), keys)
    if (pruned === undefined) break
    text = pruned
  }
  return text
}
