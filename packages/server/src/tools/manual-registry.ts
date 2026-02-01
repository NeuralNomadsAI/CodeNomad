import { ToolCategory, type ToolManual } from "./types"

/**
 * Built-in tool manual registry.
 * Maps all 14 built-in OpenCode tools to their ToolManual metadata.
 */
export const BUILTIN_TOOLS: Record<string, ToolManual> = {
  read: {
    name: "read",
    displayName: "Read File",
    description: "Read file contents from the filesystem",
    category: ToolCategory.FILE_READ,
    source: "builtin",
    riskLevel: "safe",
    mutating: false,
    tokenCost: "low",
  },
  glob: {
    name: "glob",
    displayName: "Glob Search",
    description: "Find files matching glob patterns",
    category: ToolCategory.FILE_READ,
    secondaryCategories: [ToolCategory.SEARCH],
    source: "builtin",
    riskLevel: "safe",
    mutating: false,
    tokenCost: "low",
  },
  grep: {
    name: "grep",
    displayName: "Content Search",
    description: "Search file contents with regex patterns",
    category: ToolCategory.FILE_READ,
    secondaryCategories: [ToolCategory.SEARCH],
    source: "builtin",
    riskLevel: "safe",
    mutating: false,
    tokenCost: "low",
  },
  edit: {
    name: "edit",
    displayName: "Edit File",
    description: "Make targeted edits to existing files",
    category: ToolCategory.FILE_WRITE,
    source: "builtin",
    riskLevel: "moderate",
    mutating: true,
    tokenCost: "medium",
  },
  write: {
    name: "write",
    displayName: "Write File",
    description: "Create or overwrite files",
    category: ToolCategory.FILE_WRITE,
    source: "builtin",
    riskLevel: "moderate",
    mutating: true,
    tokenCost: "medium",
  },
  patch: {
    name: "patch",
    displayName: "Patch File",
    description: "Apply patch-style changes to files",
    category: ToolCategory.FILE_WRITE,
    source: "builtin",
    riskLevel: "moderate",
    mutating: true,
    tokenCost: "medium",
  },
  bash: {
    name: "bash",
    displayName: "Shell Command",
    description: "Execute shell commands",
    category: ToolCategory.EXECUTION,
    source: "builtin",
    riskLevel: "dangerous",
    mutating: true,
    tokenCost: "high",
  },
  webfetch: {
    name: "webfetch",
    displayName: "Web Fetch",
    description: "Fetch and process web page content",
    category: ToolCategory.WEB,
    source: "builtin",
    riskLevel: "moderate",
    mutating: false,
    tokenCost: "high",
  },
  websearch: {
    name: "websearch",
    displayName: "Web Search",
    description: "Search the web for information",
    category: ToolCategory.WEB,
    source: "builtin",
    riskLevel: "moderate",
    mutating: false,
    tokenCost: "medium",
  },
  task: {
    name: "task",
    displayName: "Delegate Task",
    description: "Delegate work to specialized sub-agents",
    category: ToolCategory.DELEGATION,
    source: "builtin",
    riskLevel: "safe",
    mutating: false,
    tokenCost: "high",
  },
  skill: {
    name: "skill",
    displayName: "Load Skill",
    description: "Load a specialized skill for the current task",
    category: ToolCategory.PLANNING,
    source: "builtin",
    riskLevel: "safe",
    mutating: false,
    tokenCost: "low",
  },
  todowrite: {
    name: "todowrite",
    displayName: "Write Todo",
    description: "Create or update task items",
    category: ToolCategory.PLANNING,
    source: "builtin",
    riskLevel: "safe",
    mutating: true,
    tokenCost: "low",
  },
  todoread: {
    name: "todoread",
    displayName: "Read Todos",
    description: "Read current task items",
    category: ToolCategory.PLANNING,
    source: "builtin",
    riskLevel: "safe",
    mutating: false,
    tokenCost: "low",
  },
  lsp: {
    name: "lsp",
    displayName: "LSP Operations",
    description: "Language Server Protocol operations for code intelligence",
    category: ToolCategory.NAVIGATION,
    source: "builtin",
    riskLevel: "safe",
    mutating: false,
    tokenCost: "low",
  },
}

/** Get all tools in a given category (primary or secondary) */
export function getToolsByCategory(category: ToolCategory): ToolManual[] {
  return Object.values(BUILTIN_TOOLS).filter(
    (tool) =>
      tool.category === category ||
      (tool.secondaryCategories?.includes(category) ?? false),
  )
}

/** Get a specific tool manual by name */
export function getToolManual(name: string): ToolManual | undefined {
  return BUILTIN_TOOLS[name]
}

/** Get all registered built-in tools */
export function getAllBuiltinTools(): ToolManual[] {
  return Object.values(BUILTIN_TOOLS)
}
