import { type ToolManual, type ToolRoutingConfig, type ToolCategory } from "./types"
import { BUILTIN_TOOLS, getAllBuiltinTools } from "./manual-registry"
import { createMcpToolManual } from "./mcp-categorizer"
import { resolveAgentTools } from "./category-resolver"

interface McpToolDefinition {
  name: string
  description?: string
}

/**
 * Central tool registry managing both built-in and MCP tools.
 *
 * Built-in tools are loaded at construction.
 * MCP tools are registered/unregistered as MCP servers connect/disconnect.
 * The registry is rebuilt per workspace and lives in memory only.
 */
export class ToolRegistry {
  private readonly builtinTools: Map<string, ToolManual>
  private readonly mcpTools: Map<string, ToolManual>

  constructor() {
    this.builtinTools = new Map()
    for (const tool of getAllBuiltinTools()) {
      this.builtinTools.set(tool.name, tool)
    }
    this.mcpTools = new Map()
  }

  /** Register tools discovered from an MCP server's tools/list response */
  registerMcpTools(serverName: string, mcpToolDefinitions: McpToolDefinition[]): void {
    for (const def of mcpToolDefinitions) {
      const manual = createMcpToolManual(def.name, serverName, def)
      this.mcpTools.set(def.name, manual)
    }
  }

  /** Remove all tools registered from a specific MCP server */
  unregisterMcpServer(serverName: string): void {
    for (const [name, tool] of this.mcpTools) {
      if (tool.mcpServer === serverName) {
        this.mcpTools.delete(name)
      }
    }
  }

  /** Get all registered tools (built-in + MCP) */
  getAllTools(): ToolManual[] {
    return [...this.builtinTools.values(), ...this.mcpTools.values()]
  }

  /** Get a specific tool manual by name */
  getTool(name: string): ToolManual | undefined {
    return this.builtinTools.get(name) ?? this.mcpTools.get(name)
  }

  /** Get tools filtered for a specific agent type */
  getToolsForAgent(agentType: string, config?: ToolRoutingConfig): ToolManual[] {
    return resolveAgentTools(agentType, this.getAllTools(), config)
  }

  /** Get tool count by category (for UI display) */
  getToolCountByCategory(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const tool of this.getAllTools()) {
      counts[tool.category] = (counts[tool.category] ?? 0) + 1
    }
    return counts
  }

  /** Get total number of registered tools */
  get size(): number {
    return this.builtinTools.size + this.mcpTools.size
  }

  /** Get number of built-in tools */
  get builtinCount(): number {
    return this.builtinTools.size
  }

  /** Get number of MCP tools */
  get mcpCount(): number {
    return this.mcpTools.size
  }
}
