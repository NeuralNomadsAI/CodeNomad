import type { ConfigGetOutput, PermissionRule } from "@opencode/client"
import { z } from "zod"

export const sessionPermissionRules = z.array(z.object({
  action: z.string(),
  resource: z.string(),
  effect: z.enum(["allow", "ask", "deny"]),
}).strict())

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

export function supervisedRules(entries: ConfigGetOutput, ignoreCase: boolean): PermissionRule[] {
  const actions = ["edit", "shell"]
  const block: PermissionRule[] = actions.map(action => ({ action, resource: "*", effect: "ask" }))
  if (!Array.isArray(entries)) throw new Error("Invalid native configuration")
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const rule of sessionPermissionRules.parse(entry.info.permissions ?? [])) {
      // Match the native action pattern, but emit only the two exact actions.
      let pattern = rule.action.replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
      if (pattern.endsWith(" .*")) pattern = `${pattern.slice(0, -3)}( .*)?`
      const matcher = new RegExp(`^${pattern}$`, ignoreCase ? "is" : "s")
      for (const action of actions) {
        if (!matcher.test(action)) continue
        // The native config loader expands these paths; session rules do not.
        // Without an authoritative native home, reject instead of losing a deny.
        if (action === "edit" && rule.action === "edit" && /^(?:~(?:\/|$)|\$HOME(?:[\\/]|$))/.test(rule.resource)) {
          throw new Error("Cannot project a home-relative edit permission")
        }
        block.push({ action, resource: rule.resource, effect: rule.effect === "deny" ? "deny" : "ask" })
      }
    }
  }
  return block
}
