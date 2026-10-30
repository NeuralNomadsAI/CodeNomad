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
/** A policy file's current text: `undefined` when missing. */
export type NestingSource = { path: string; text?: string; unreadable?: boolean }
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

/** The files whose current content admission compares with what OpenCode loaded, all derived from the
 * native entries (`paths` is the execution host's path module): every listed configuration document, and
 * in every listed configuration directory (Global and each discovered `.opencode`) its configuration
 * documents and the General agent files OpenCode reads there. */
export function nestingSources(entries: readonly unknown[], paths: Pick<typeof import("node:path"), "join">) {
  const listed = (type: string) => (entries as Entry[]).flatMap(entry => entry?.type === type && typeof entry.path === "string" ? [entry.path] : [])
  const directories = listed("directory")
  return {
    documents: [...listed("document"), ...directories.flatMap(directory => ["opencode.json", "opencode.jsonc"].map(name => paths.join(directory, name)))],
    agents: directories.flatMap(directory => [paths.join(directory, "agents", "general.md"), paths.join(directory, "agent", "general.md")]),
  }
}

/** Whether a General agent file's frontmatter can carry permissions. Nothing in the native contract attributes
 * loaded rules to the file, so its rules cannot be reconciled with its content: any mention counts. */
function agentFileMayDecide(text: string): boolean {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return false
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  return end < 0 || /permission|tools/i.test(lines.slice(1, end).join("\n"))
}

/** Whether every policy source OpenCode reported is settled: each document's `subagent` rules on disk equal
 * its loaded entry (a file that is unlisted, missing or listed only on one side counts as empty there), and
 * no General agent file can set permissions. Native reloads lag behind writes, so anything else, unreadable
 * or uncomparable content included, makes the resolved rules uncertain. `project` is the owned project
 * document, whose CodeNomad rule may be in flight. */
export function nestingSourcesLoaded(documents: readonly NestingSource[], agents: readonly NestingSource[],
  entries: readonly unknown[], project: string | undefined, samePath: (left: string, right: string) => boolean): boolean {
  if ([...documents, ...agents].some(source => source.unreadable)) return false
  const settled = documents.every(({ path, text }) => {
    const errors: ParseError[] = []
    const fresh = text === undefined ? {} : parse(text, errors, { allowTrailingComma: true })
    const entry = (entries as Entry[]).find(entry => entry?.type === "document" && entry.path !== undefined && samePath(entry.path, path))
    const own = project !== undefined && samePath(path, project)
    const [disk, loaded] = [documentRules(fresh, own), documentRules(entry?.info, own)]
    return errors.length === 0 && disk !== undefined && loaded !== undefined && isDeepStrictEqual(disk, loaded)
  })
  return settled && agents.every(({ text }) => text === undefined || !agentFileMayDecide(text))
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
