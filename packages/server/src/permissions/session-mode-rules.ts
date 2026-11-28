import type { ConfigGetOutput, PermissionRule } from "@opencode/client"
import { sessionPermissionRules } from "../opencode/session-pruning/permission-rules-contract"
export { sessionPermissionRules }

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}

export function sameRules(a: readonly PermissionRule[], b: readonly PermissionRule[]): boolean {
  return a.length === b.length && a.every((rule, index) => sameRule(rule, b[index]))
}

export function blockPositions(rules: readonly PermissionRule[], block: readonly PermissionRule[]): number[] {
  return rules.flatMap((_, offset) => (
    block.length <= rules.length - offset && block.every((rule, index) => sameRule(rule, rules[offset + index])) ? [offset] : []
  ))
}

const supervisedActions = ["edit", "shell"]

function projectRules(rules: readonly PermissionRule[], ignoreCase: boolean, fromConfig = false): PermissionRule[] {
  const projected: PermissionRule[] = []
  for (const rule of rules) {
    // Match the native action pattern, but emit only the two exact actions.
    let pattern = rule.action.replaceAll("\\", "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
    if (pattern.endsWith(" .*")) pattern = `${pattern.slice(0, -3)}( .*)?`
    const matcher = new RegExp(`^${pattern}$`, ignoreCase ? "is" : "s")
    for (const action of supervisedActions) {
      if (!matcher.test(action)) continue
      // The native config loader expands these paths; session rules do not.
      // Without an authoritative native home, reject instead of losing a deny.
      if (fromConfig && action === "edit" && rule.action === "edit" && /^(?:~(?:\/|$)|\$HOME(?:[\\/]|$))/.test(rule.resource)) {
        throw new Error("Cannot project a home-relative edit permission")
      }
      projected.push({ action, resource: rule.resource, effect: rule.effect === "allow" ? "ask" : rule.effect })
    }
  }
  return projected
}

export function supervisedRules(entries: ConfigGetOutput, ignoreCase: boolean): PermissionRule[] {
  const block: PermissionRule[] = supervisedActions.map(action => ({ action, resource: "*", effect: "ask" }))
  if (!Array.isArray(entries)) throw new Error("Invalid native configuration")
  for (const entry of entries) {
    if (entry.type !== "document") continue
    block.push(...projectRules(sessionPermissionRules.parse(entry.info.permissions ?? []), ignoreCase, true))
  }
  return block
}

export function appendSessionProjection(block: PermissionRule[], rules: readonly PermissionRule[], distro: string | undefined): PermissionRule[] {
  return [...block, ...projectRules(rules, process.platform === "win32" && !distro)]
}
