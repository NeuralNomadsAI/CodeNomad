import { createSignal, createMemo } from "solid-js"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"

const log = getLogger("era-governance")

function apiUrl(path: string): string {
  return ERA_CODE_API_BASE ? `${ERA_CODE_API_BASE}${path}` : path
}

/**
 * A governance rule that controls what commands can be executed
 */
export interface GovernanceRule {
  id: string
  pattern: string
  reason: string
  suggestion?: string
  overridable: boolean
  source: "hardcoded" | "default" | "global" | "project" | "local"
  action: "allow" | "deny"
  categoryId?: string
  categoryName?: string
  isOverridden?: boolean
}

/**
 * A category of governance rules
 */
export interface GovernanceCategory {
  categoryId: string
  categoryName: string
  rules: GovernanceRule[]
}

/**
 * Summary of governance state
 */
export interface GovernanceSummary {
  totalRules: number
  hardcodedRules: number
  defaultRules: number
  customRules: number
  activeOverrides: number
  overriddenRules: number
  auditMode: boolean
  defaultAgent?: string
}

/**
 * Result of evaluating a command against governance rules
 */
export interface GovernanceDecision {
  allowed: boolean
  rule?: string
  reason?: string
  suggestion?: string
  overridable: boolean
}

/**
 * Governance state
 */
interface GovernanceState {
  loading: boolean
  error: string | null
  rules: GovernanceRule[]
  categories: GovernanceCategory[]
  summary: GovernanceSummary | null
  lastFetched: number | null
}

const initialState: GovernanceState = {
  loading: false,
  error: null,
  rules: [],
  categories: [],
  summary: null,
  lastFetched: null,
}

const [governanceState, setGovernanceState] = createSignal<GovernanceState>(initialState)

let currentFolder: string | null = null

/**
 * Fetch governance rules from the server
 */
async function fetchGovernanceRules(folder?: string): Promise<void> {
  setGovernanceState((prev) => ({ ...prev, loading: true, error: null }))

  try {
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : ""

    // Fetch both rules and summary in parallel
    const [rulesResponse, summaryResponse] = await Promise.all([
      fetch(apiUrl(`/api/era/governance/rules${params}`)),
      fetch(apiUrl(`/api/era/governance/summary${params}`)),
    ])

    if (!rulesResponse.ok) {
      throw new Error(`Failed to fetch governance rules: ${rulesResponse.statusText}`)
    }

    if (!summaryResponse.ok) {
      throw new Error(`Failed to fetch governance summary: ${summaryResponse.statusText}`)
    }

    const rulesData = await rulesResponse.json()
    const summaryData = await summaryResponse.json()

    // Build categories from rules if they have category info
    const categoriesMap = new Map<string, GovernanceCategory>()
    for (const rule of rulesData.rules ?? []) {
      if (rule.categoryId) {
        if (!categoriesMap.has(rule.categoryId)) {
          categoriesMap.set(rule.categoryId, {
            categoryId: rule.categoryId,
            categoryName: rule.categoryName ?? rule.categoryId,
            rules: [],
          })
        }
        categoriesMap.get(rule.categoryId)!.rules.push(rule)
      }
    }

    // Map summary data to our expected format
    const summary: GovernanceSummary = {
      totalRules: summaryData.success ? summaryData.summary?.totalRules ?? 0 : 0,
      hardcodedRules: 0, // Not tracked separately in new API
      defaultRules: summaryData.success ? summaryData.summary?.totalRules ?? 0 : 0,
      customRules: 0,
      activeOverrides: summaryData.success ? summaryData.summary?.overriddenRules ?? 0 : 0,
      overriddenRules: summaryData.success ? summaryData.summary?.overriddenRules ?? 0 : 0,
      auditMode: summaryData.success ? summaryData.summary?.auditMode ?? false : false,
      defaultAgent: summaryData.success ? summaryData.summary?.defaultAgent : undefined,
    }

    setGovernanceState({
      loading: false,
      error: null,
      rules: rulesData.rules ?? [],
      categories: Array.from(categoriesMap.values()),
      summary,
      lastFetched: Date.now(),
    })

    log.info("Governance rules fetched", {
      totalRules: (rulesData.rules ?? []).length,
      categories: categoriesMap.size,
      auditMode: summary.auditMode,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    log.warn("Failed to fetch governance rules", { error: errorMessage })

    setGovernanceState((prev) => ({
      ...prev,
      loading: false,
      error: errorMessage,
    }))
  }
}

/**
 * Evaluate a command against governance rules
 */
export async function evaluateCommand(
  command: string,
  folder?: string
): Promise<GovernanceDecision> {
  try {
    const response = await fetch(apiUrl("/api/era/governance/evaluate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command, folder }),
    })

    if (!response.ok) {
      throw new Error(`Failed to evaluate command: ${response.statusText}`)
    }

    const data = await response.json()
    return data.decision
  } catch (error) {
    log.warn("Failed to evaluate command", { error })
    // Default to allowing if evaluation fails
    return {
      allowed: true,
      overridable: false,
    }
  }
}

/**
 * Refresh governance rules for a specific folder
 */
export function refreshGovernanceRules(folder?: string): void {
  currentFolder = folder ?? null
  void fetchGovernanceRules(folder)
}

/**
 * Set an override for a rule
 */
export async function setRuleOverride(
  ruleId: string,
  action: "allow" | "deny",
  justification: string,
  folder: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(apiUrl("/api/era/governance/override"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ruleId, action, justification, folder }),
    })

    const data = await response.json()

    if (data.success) {
      // Refresh rules after successful override
      void fetchGovernanceRules(folder)
      log.info("Rule override set", { ruleId, action })
    }

    return data
  } catch (error) {
    log.warn("Failed to set rule override", { error })
    return { success: false, error: "Failed to set override" }
  }
}

/**
 * Remove an override for a rule
 */
export async function removeRuleOverride(
  ruleId: string,
  folder: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(apiUrl("/api/era/governance/override"), {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ruleId, folder }),
    })

    const data = await response.json()

    if (data.success) {
      // Refresh rules after successful removal
      void fetchGovernanceRules(folder)
      log.info("Rule override removed", { ruleId })
    }

    return data
  } catch (error) {
    log.warn("Failed to remove rule override", { error })
    return { success: false, error: "Failed to remove override" }
  }
}

/**
 * Get the current governance state
 */
export function useGovernanceState() {
  return governanceState
}

/**
 * Derived: All governance rules
 */
export const governanceRules = createMemo(() => governanceState().rules)

/**
 * Derived: Governance summary
 */
export const governanceSummary = createMemo(() => governanceState().summary)

/**
 * Derived: Hardcoded rules (cannot be overridden)
 */
export const hardcodedRules = createMemo(() =>
  governanceState().rules.filter((r) => r.source === "hardcoded")
)

/**
 * Derived: Default rules (can be overridden)
 */
export const defaultRules = createMemo(() =>
  governanceState().rules.filter((r) => r.source === "default")
)

/**
 * Derived: Project-specific rules
 */
export const projectRules = createMemo(() =>
  governanceState().rules.filter((r) => r.source === "project")
)

/**
 * Derived: Overridable rules
 */
export const overridableRules = createMemo(() =>
  governanceState().rules.filter((r) => r.overridable)
)

/**
 * Derived: Active deny rules
 */
export const activeDenyRules = createMemo(() =>
  governanceState().rules.filter((r) => r.action === "deny")
)

/**
 * Derived: Count of active overrides
 */
export const activeOverridesCount = createMemo(
  () => governanceState().summary?.activeOverrides ?? 0
)

/**
 * Derived: Is audit mode enabled?
 */
export const isAuditMode = createMemo(() => governanceState().summary?.auditMode ?? false)

/**
 * Derived: Is governance loading?
 */
export const isGovernanceLoading = createMemo(() => governanceState().loading)

/**
 * Derived: Governance error
 */
export const governanceError = createMemo(() => governanceState().error)

/**
 * Derived: Governance categories
 */
export const governanceCategories = createMemo(() => governanceState().categories)

/**
 * Get governance status summary for display
 */
export const governanceStatusSummary = createMemo(() => {
  const state = governanceState()

  if (state.loading) {
    return "Loading..."
  }

  if (state.error) {
    return "Error loading rules"
  }

  if (!state.summary) {
    return "Not loaded"
  }

  const { totalRules, activeOverrides, auditMode } = state.summary

  if (auditMode) {
    return `${totalRules} rules (Audit Mode)`
  }

  if (activeOverrides > 0) {
    return `${totalRules} rules, ${activeOverrides} overrides`
  }

  return `${totalRules} rules active`
})
