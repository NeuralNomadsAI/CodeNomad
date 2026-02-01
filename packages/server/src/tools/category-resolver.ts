import { type ToolManual, type ToolRoutingConfig } from "./types"
import { getAgentProfile } from "./agent-profiles"

/**
 * Check whether a specific tool should be accessible to a given agent.
 *
 * Resolution order (deny steps run first, then allow steps):
 * 1. Global deny list (blocks for ALL agents)
 * 2. User per-agent deny list
 * 3. Agent profile denied tools  ← HARD SECURITY BOUNDARY
 * 4. Agent profile required tools (overrides category filtering)
 * 5. User per-agent added tools (overrides category filtering)
 * 6. Category filtering (with user overrides applied)
 *
 * SECURITY NOTE: Steps 1-3 (deny lists) execute before steps 4-5 (add lists).
 * This means profile.deniedTools is a hard security boundary — user addTools
 * CANNOT override it. To grant a profile-denied tool, the profile itself must
 * be changed. This is intentional: agents like "reviewer" must never receive
 * "edit" regardless of user preferences.
 *
 * Example: reviewer denies ["edit", "write", "bash", ...]. Even if a user
 * configures addTools: ["bash"] for reviewer, bash remains blocked at step 3
 * before addTools is evaluated at step 5.
 */
export function resolveToolAccess(
  agentType: string,
  tool: ToolManual,
  config?: ToolRoutingConfig,
): boolean {
  const profile = getAgentProfile(agentType)
  const userProfile = config?.profiles?.[agentType]

  // Step 1: Global deny
  if (config?.globalDeny?.includes(tool.name)) {
    return false
  }

  // Step 2: User per-agent deny
  if (userProfile?.denyTools?.includes(tool.name)) {
    return false
  }

  // Step 3: Agent profile denied
  if (profile.deniedTools.includes(tool.name)) {
    return false
  }

  // Step 4: Agent profile required (bypass category check)
  if (profile.requiredTools.includes(tool.name)) {
    return true
  }

  // Step 5: User per-agent added tools (bypass category check)
  if (userProfile?.addTools?.includes(tool.name)) {
    return true
  }

  // Step 6: Category check with user overrides
  const effectiveCategories = new Set(profile.allowedCategories)

  if (userProfile?.addCategories) {
    for (const cat of userProfile.addCategories) {
      effectiveCategories.add(cat)
    }
  }

  if (userProfile?.removeCategories) {
    for (const cat of userProfile.removeCategories) {
      effectiveCategories.delete(cat)
    }
  }

  // Check primary category
  if (effectiveCategories.has(tool.category)) {
    return true
  }

  // Check secondary categories
  if (tool.secondaryCategories) {
    for (const cat of tool.secondaryCategories) {
      if (effectiveCategories.has(cat)) {
        return true
      }
    }
  }

  return false
}

/**
 * Get the full filtered tool list for a given agent type.
 * Applies all filtering rules and returns the final set.
 */
export function resolveAgentTools(
  agentType: string,
  allTools: ToolManual[],
  config?: ToolRoutingConfig,
): ToolManual[] {
  const profile = getAgentProfile(agentType)

  const resolved = allTools.filter((tool) => resolveToolAccess(agentType, tool, config))

  // Apply maxToolCount if set
  if (profile.maxToolCount && resolved.length > profile.maxToolCount) {
    return resolved.slice(0, profile.maxToolCount)
  }

  return resolved
}
