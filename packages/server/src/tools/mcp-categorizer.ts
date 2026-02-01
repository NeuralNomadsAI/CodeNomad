import { ToolCategory, type ToolManual } from "./types"

/**
 * Explicit mapping of known MCP tool names to categories.
 * Highest priority in the categorization chain.
 */
const KNOWN_MCP_TOOL_MAP: Record<string, ToolCategory> = {
  // Notion tools
  notion_search: ToolCategory.SEARCH,
  notion_fetch: ToolCategory.FILE_READ,
  notion_list_children: ToolCategory.FILE_READ,

  // Linear tools
  list_issues: ToolCategory.SEARCH,
  get_issue: ToolCategory.FILE_READ,
  create_issue: ToolCategory.PLANNING,
  update_issue: ToolCategory.PLANNING,
  list_comments: ToolCategory.FILE_READ,
  create_comment: ToolCategory.PLANNING,
  list_projects: ToolCategory.SEARCH,
  get_project: ToolCategory.FILE_READ,
  create_project: ToolCategory.PLANNING,
  update_project: ToolCategory.PLANNING,
  list_teams: ToolCategory.SEARCH,
  get_team: ToolCategory.FILE_READ,
  list_users: ToolCategory.SEARCH,
  get_user: ToolCategory.FILE_READ,
  list_cycles: ToolCategory.SEARCH,
  list_documents: ToolCategory.SEARCH,
  get_document: ToolCategory.FILE_READ,
  create_document: ToolCategory.PLANNING,
  update_document: ToolCategory.PLANNING,
  list_issue_statuses: ToolCategory.SEARCH,
  list_issue_labels: ToolCategory.SEARCH,
  create_issue_label: ToolCategory.PLANNING,
  list_project_labels: ToolCategory.SEARCH,
  search_documentation: ToolCategory.SEARCH,

  // Playwright tools
  navigate: ToolCategory.EXECUTION,
  screenshot: ToolCategory.FILE_READ,
  click: ToolCategory.EXECUTION,
  fill: ToolCategory.EXECUTION,
  evaluate: ToolCategory.EXECUTION,
}

/**
 * Default category for all tools from a given MCP server.
 * Used when a tool isn't in KNOWN_MCP_TOOL_MAP.
 */
const SERVER_DEFAULT_CATEGORIES: Record<string, ToolCategory> = {
  "linear-server": ToolCategory.PLANNING,
  "notion-docs-reader": ToolCategory.FILE_READ,
  playwright: ToolCategory.EXECUTION,
}

/**
 * Heuristic patterns for categorizing unknown tools by name.
 * Applied when neither explicit map nor server default matches.
 */
const NAME_HEURISTICS: Array<{ pattern: RegExp; category: ToolCategory }> = [
  { pattern: /search|find|list|query/i, category: ToolCategory.SEARCH },
  { pattern: /create|write|update|delete|remove|insert|set/i, category: ToolCategory.FILE_WRITE },
  { pattern: /read|get|fetch|view|show|describe/i, category: ToolCategory.FILE_READ },
  { pattern: /run|execute|invoke|launch|start|stop/i, category: ToolCategory.EXECUTION },
]

/**
 * Categorize an MCP tool using the 3-strategy priority system:
 * 1. Explicit mapping (highest priority)
 * 2. Server-level default
 * 3. Name heuristic
 * 4. Fallback to FILE_READ (safest default)
 */
export function categorizeMcpTool(
  toolName: string,
  serverName: string,
  _toolDescription?: string,
): ToolCategory {
  // Strategy 1: Explicit map
  if (toolName in KNOWN_MCP_TOOL_MAP) {
    return KNOWN_MCP_TOOL_MAP[toolName]
  }

  // Strategy 2: Server default
  if (serverName in SERVER_DEFAULT_CATEGORIES) {
    return SERVER_DEFAULT_CATEGORIES[serverName]
  }

  // Strategy 3: Name heuristic
  for (const { pattern, category } of NAME_HEURISTICS) {
    if (pattern.test(toolName)) {
      return category
    }
  }

  // Fallback: FILE_READ (safest — read-only)
  return ToolCategory.FILE_READ
}

/**
 * Create a ToolManual from MCP tool discovery data.
 */
export function createMcpToolManual(
  toolName: string,
  serverName: string,
  mcpToolDefinition: { description?: string },
): ToolManual {
  const category = categorizeMcpTool(toolName, serverName, mcpToolDefinition.description)

  return {
    name: toolName,
    displayName: toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: mcpToolDefinition.description ?? `MCP tool from ${serverName}`,
    category,
    source: "mcp",
    mcpServer: serverName,
    riskLevel: category === ToolCategory.EXECUTION ? "dangerous" : category === ToolCategory.FILE_WRITE ? "moderate" : "safe",
    mutating: category === ToolCategory.FILE_WRITE || category === ToolCategory.EXECUTION || category === ToolCategory.PLANNING,
    tokenCost: "medium",
  }
}
