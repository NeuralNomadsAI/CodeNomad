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
/** Written inside the rule CodeNomad adds: only a rule carrying it is CodeNomad's to remove. It ends with
 * the outermost container CodeNomad created for the rule, the only ones Inherit may prune. */
const MARKER = "Added by CodeNomad with the project subagent depth; Inherit removes it"

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
type Location = (typeof LOCATIONS)[number]
type Owned = { location: Location; path: (string | number)[]; created?: string }
const full = (document: PluginControlDocument) => `${document.byteOrderMark ? String.fromCharCode(0xfeff) : ""}${document.text}`

/** The marked rule's source at `path` when it is CodeNomad's, unchanged. */
const marked = (document: PluginControlDocument, path: (string | number)[], rule: unknown) => {
  const node = findNodeAtLocation(parseTree(document.text, [], { allowTrailingComma: true })!, path)
  const source = node ? document.text.slice(node.offset, node.offset + node.length) : ""
  return source.includes(MARKER) && isDeepStrictEqual(parse(source, [], { allowTrailingComma: true }), rule) ? source : undefined
}

/** CodeNomad's rules in every General block of the document, with the outermost container each created. */
function ownedRules(document: PluginControlDocument): Owned[] {
  return LOCATIONS.flatMap(location => {
    const { keys, legacy } = location
    try {
      const container = [...keys, legacy ? "permission" : "permissions"], value = readNativeSetting(document, container)
      const members: (string | number)[] = legacy ? (object(value) ? LEGACY_KEYS : []) : Array.isArray(value) ? value.map((_, index) => index) : []
      return members.flatMap(member => {
        const source = marked(document, [...container, member], legacy ? LEGACY_RULE : RULE)
        return source === undefined ? [] : [{ location, path: [...container, member], created: /removes it with `(\w+)`/.exec(source)?.[1] }]
      })
    } catch { return [] }
  })
}

/** The General block OpenCode uses in this document; a new one is native. */
function winning(document: PluginControlDocument): Location {
  return LOCATIONS.find(location => readNativeSetting(document, [...location.keys]) !== undefined) ?? LOCATIONS[0]
}

/** The text without one owned rule and the containers up to the one it created, while they are empty. */
function removeOwned(document: PluginControlDocument, owned: Owned): string | undefined {
  const container = owned.path.slice(0, 3) as string[], member = owned.path[3]
  const removed = typeof member === "number" ? removeNativeListElement(document, container, member)
    : removeNativeProperty(document, [...container, member])
  if (removed === undefined) return undefined
  let text = removed
  for (let length = 3; owned.created !== undefined && length >= 1; length--) {
    const keys = container.slice(0, length), current = withEditedText(document, text)
    const pruned = removeEmptyNativeList(current, keys) ?? removeEmptyNativeObject(current, keys)
    if (pruned === undefined) break
    text = pruned
    if (keys.at(-1) === owned.created) break
  }
  return text
}

/** The rule appended to the winning block: native rules last in `agents.general.permissions`, or a legacy
 * `permission` property (`subagent`, else `task`) that no earlier `tools` or `permission` key holds, so it
 * stays last. The marker names the outermost container it creates. `undefined` when that needs rewriting the
 * user's own value (a string `permission`, both keys taken). */
function addRule(document: PluginControlDocument, { keys, legacy }: Location): string | undefined {
  const container = [...keys, legacy ? "permission" : "permissions"]
  const created = container.find((_, index) => readNativeSetting(document, container.slice(0, index + 1)) === undefined)
  const marker = created === undefined ? `${MARKER}.` : `${MARKER} with \`${created}\`.`
  if (!legacy) return appendNativeSetting(document, container, RULE, marker)
  const permission = readNativeSetting(document, container), tools = readNativeSetting(document, [...keys, "tools"])
  if (permission !== undefined && !object(permission)) return undefined
  const taken = new Set([...Object.keys(permission ?? {}), ...Object.keys(object(tools) ? tools : {})])
  const name = LEGACY_KEYS.find(key => !taken.has(key))
  return name === undefined ? undefined : appendNativeProperty(document, container, name, LEGACY_RULE, marker)
}

/** The text with CodeNomad's rule in the General block the document uses, so no new block replaces it, and
 * without its rules in superseded blocks; `undefined` when the winning block cannot take it (`addRule`). */
export function withNestingRule(document: PluginControlDocument): string | undefined {
  const winner = winning(document)
  let current = document
  for (let stale = ownedRules(current).find(owned => owned.location !== winner); stale; stale = ownedRules(current).find(owned => owned.location !== winner)) {
    const removed = removeOwned(current, stale)
    if (removed === undefined) break
    current = withEditedText(document, removed)
  }
  return ownedRules(current).some(owned => owned.location === winner) ? full(current) : addRule(current, winner)
}

/** Whether a project override saved only the depth: the winning General block has no CodeNomad rule and
 * cannot take one without rewriting the user's value. */
export function nestingRuleSkipped(document: PluginControlDocument): boolean {
  try {
    const winner = winning(document)
    return !ownedRules(document).some(owned => owned.location === winner) && addRule(document, winner) === undefined
  } catch { return false }
}

/** The text without any of CodeNomad's rules and the containers they created; `undefined` without one. */
export function withoutNestingRule(document: PluginControlDocument): string | undefined {
  let current = document, changed = false
  for (let owned = ownedRules(current)[0]; owned; owned = ownedRules(current)[0]) {
    const removed = removeOwned(current, owned)
    if (removed === undefined) break
    current = withEditedText(document, removed)
    changed = true
  }
  return changed ? full(current) : undefined
}

export function hasNestingRule(document: PluginControlDocument): boolean {
  return ownedRules(document).length > 0
}
