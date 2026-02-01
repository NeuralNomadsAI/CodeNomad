/**
 * UTCP-inspired tool types for agent tool routing.
 *
 * Tools are categorized and agents receive only the tools
 * relevant to their role, reducing context window waste
 * and preventing misuse.
 */

export enum ToolCategory {
  FILE_READ = "file-read",
  FILE_WRITE = "file-write",
  EXECUTION = "execution",
  WEB = "web",
  PLANNING = "planning",
  DELEGATION = "delegation",
  SEARCH = "search",
  NAVIGATION = "navigation",
}

export interface ToolManual {
  /** Unique identifier (e.g., "read", "notion_search") */
  name: string
  /** Human-readable display name */
  displayName: string
  /** What the tool does */
  description: string
  /** Primary category */
  category: ToolCategory
  /** Additional categories this tool belongs to */
  secondaryCategories?: ToolCategory[]
  /** Where the tool comes from */
  source: "builtin" | "mcp"
  /** MCP server name (if source is "mcp") */
  mcpServer?: string
  /** Risk level for governance */
  riskLevel: "safe" | "moderate" | "dangerous"
  /** Whether the tool modifies state */
  mutating: boolean
  /** Approximate context cost of including this tool's definition */
  tokenCost: "low" | "medium" | "high"
}

export interface AgentToolProfile {
  /** Agent type identifier */
  agentType: string
  /** Categories this agent is allowed to use */
  allowedCategories: Set<ToolCategory>
  /** Tools explicitly denied regardless of category */
  deniedTools: string[]
  /** Tools always included regardless of category */
  requiredTools: string[]
  /** Optional cap on total tools for context budget */
  maxToolCount?: number
}

export interface ToolRoutingConfig {
  /** Tools denied to ALL agents */
  globalDeny: string[]
  /** Per-agent overrides */
  profiles: Record<
    string,
    {
      addCategories?: ToolCategory[]
      removeCategories?: ToolCategory[]
      addTools?: string[]
      denyTools?: string[]
    }
  >
}
