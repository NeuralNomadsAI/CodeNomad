import { ToolCategory, type AgentToolProfile } from "./types"

/**
 * Default agent tool profiles defining which tool categories
 * and specific tools each agent type can access.
 */
export const DEFAULT_AGENT_PROFILES: Record<string, AgentToolProfile> = {
  main: {
    agentType: "main",
    allowedCategories: new Set(Object.values(ToolCategory)),
    deniedTools: [],
    requiredTools: ["skill"],
  },
  plan: {
    agentType: "plan",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.SEARCH,
      ToolCategory.WEB,
      ToolCategory.PLANNING,
      ToolCategory.DELEGATION,
      ToolCategory.NAVIGATION,
    ]),
    deniedTools: ["write", "todowrite", "todoread", "patch"],
    requiredTools: ["skill"],
  },
  explore: {
    agentType: "explore",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.SEARCH,
      ToolCategory.NAVIGATION,
    ]),
    deniedTools: ["edit", "write", "bash", "webfetch", "websearch", "todowrite", "todoread", "patch", "skill"],
    requiredTools: ["task"],
  },
  debugger: {
    agentType: "debugger",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.FILE_WRITE,
      ToolCategory.EXECUTION,
      ToolCategory.SEARCH,
      ToolCategory.NAVIGATION,
    ]),
    deniedTools: ["write", "webfetch", "websearch", "todowrite", "todoread", "patch"],
    requiredTools: ["skill"],
  },
  researcher: {
    agentType: "researcher",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.SEARCH,
      ToolCategory.WEB,
      ToolCategory.DELEGATION,
      ToolCategory.NAVIGATION,
    ]),
    deniedTools: ["edit", "write", "todowrite", "todoread", "patch"],
    requiredTools: ["skill"],
  },
  "docs-generator": {
    agentType: "docs-generator",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.FILE_WRITE,
      ToolCategory.SEARCH,
    ]),
    deniedTools: ["write", "bash", "webfetch", "websearch", "task", "todowrite", "todoread", "patch", "skill"],
    requiredTools: [],
  },
  "readme-generator": {
    agentType: "readme-generator",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.FILE_WRITE,
      ToolCategory.SEARCH,
    ]),
    deniedTools: ["write", "bash", "webfetch", "websearch", "task", "todowrite", "todoread", "patch", "skill"],
    requiredTools: [],
  },
  coder: {
    agentType: "coder",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.FILE_WRITE,
      ToolCategory.EXECUTION,
      ToolCategory.SEARCH,
    ]),
    deniedTools: ["task", "webfetch", "websearch", "todowrite", "todoread"],
    requiredTools: ["skill"],
  },
  "test-writer": {
    agentType: "test-writer",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.FILE_WRITE,
      ToolCategory.EXECUTION,
      ToolCategory.SEARCH,
    ]),
    deniedTools: ["task", "webfetch", "websearch", "todowrite", "todoread", "patch"],
    requiredTools: ["skill"],
  },
  reviewer: {
    agentType: "reviewer",
    allowedCategories: new Set([
      ToolCategory.FILE_READ,
      ToolCategory.SEARCH,
      ToolCategory.NAVIGATION,
    ]),
    deniedTools: ["edit", "write", "bash", "webfetch", "websearch", "todowrite", "todoread", "task", "patch"],
    requiredTools: ["skill"],
  },
}

/**
 * Get the tool profile for an agent type.
 * Returns a permissive default for unknown agent types.
 */
export function getAgentProfile(agentType: string): AgentToolProfile {
  const profile = DEFAULT_AGENT_PROFILES[agentType]
  if (profile) return profile

  // Permissive default for unknown agent types
  return {
    agentType,
    allowedCategories: new Set(Object.values(ToolCategory)),
    deniedTools: [],
    requiredTools: [],
  }
}
