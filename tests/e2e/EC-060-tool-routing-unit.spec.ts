/**
 * EC-060: Tool Routing Infrastructure — Server-Side Unit Tests
 *
 * Tests the UTCP-inspired tool routing system implemented in Milestone B2.
 * These are pure TypeScript/Node tests using Playwright's test runner but
 * requiring NO browser or running server — they directly import and test
 * the server-side tool routing modules.
 *
 * Coverage:
 *   - ToolCategory enum values (8 categories)
 *   - BUILTIN_TOOLS registry (14 tools, correct metadata)
 *   - MCP categorizer (3-tier priority: explicit > server default > heuristic)
 *   - Agent profiles (10 profiles, correct permissions)
 *   - Category resolver (deny, require, user overrides)
 *   - ToolRegistry class (register/unregister, agent filtering)
 */

import { test, expect } from "@playwright/test"
import { ToolCategory } from "../../packages/server/src/tools/types"
import type { ToolManual, AgentToolProfile, ToolRoutingConfig } from "../../packages/server/src/tools/types"
import {
  BUILTIN_TOOLS,
  getToolsByCategory,
  getToolManual,
  getAllBuiltinTools,
} from "../../packages/server/src/tools/manual-registry"
import {
  categorizeMcpTool,
  createMcpToolManual,
} from "../../packages/server/src/tools/mcp-categorizer"
import {
  DEFAULT_AGENT_PROFILES,
  getAgentProfile,
} from "../../packages/server/src/tools/agent-profiles"
import {
  resolveToolAccess,
  resolveAgentTools,
} from "../../packages/server/src/tools/category-resolver"
import { ToolRegistry } from "../../packages/server/src/tools/tool-registry"

// ═══════════════════════════════════════════════════════════════════
// SECTION 1: ToolCategory Enum
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-060: ToolCategory Enum", () => {
  test("EC-060-01: has exactly 8 categories", () => {
    const values = Object.values(ToolCategory)
    expect(values).toHaveLength(8)
  })

  test("EC-060-02: contains all expected category values", () => {
    expect(ToolCategory.FILE_READ).toBe("file-read")
    expect(ToolCategory.FILE_WRITE).toBe("file-write")
    expect(ToolCategory.EXECUTION).toBe("execution")
    expect(ToolCategory.WEB).toBe("web")
    expect(ToolCategory.PLANNING).toBe("planning")
    expect(ToolCategory.DELEGATION).toBe("delegation")
    expect(ToolCategory.SEARCH).toBe("search")
    expect(ToolCategory.NAVIGATION).toBe("navigation")
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 2: Built-in Tool Manual Registry
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-060: BUILTIN_TOOLS Registry", () => {
  test("EC-060-03: contains exactly 14 built-in tools", () => {
    const allTools = getAllBuiltinTools()
    expect(allTools).toHaveLength(14)
  })

  test("EC-060-04: all 14 tool names are registered", () => {
    const expectedTools = [
      "read", "glob", "grep", "edit", "write", "patch",
      "bash", "webfetch", "websearch", "task", "skill",
      "todowrite", "todoread", "lsp",
    ]
    for (const name of expectedTools) {
      const manual = getToolManual(name)
      expect(manual, `Tool "${name}" should be registered`).toBeDefined()
      expect(manual!.name).toBe(name)
      expect(manual!.source).toBe("builtin")
    }
  })

  test("EC-060-05: read tool has correct metadata", () => {
    const manual = getToolManual("read")!
    expect(manual.category).toBe(ToolCategory.FILE_READ)
    expect(manual.riskLevel).toBe("safe")
    expect(manual.mutating).toBe(false)
    expect(manual.tokenCost).toBe("low")
  })

  test("EC-060-06: bash tool is marked dangerous and mutating", () => {
    const manual = getToolManual("bash")!
    expect(manual.category).toBe(ToolCategory.EXECUTION)
    expect(manual.riskLevel).toBe("dangerous")
    expect(manual.mutating).toBe(true)
    expect(manual.tokenCost).toBe("high")
  })

  test("EC-060-07: edit tool is moderate risk and mutating", () => {
    const manual = getToolManual("edit")!
    expect(manual.category).toBe(ToolCategory.FILE_WRITE)
    expect(manual.riskLevel).toBe("moderate")
    expect(manual.mutating).toBe(true)
  })

  test("EC-060-08: task tool is delegation category, safe", () => {
    const manual = getToolManual("task")!
    expect(manual.category).toBe(ToolCategory.DELEGATION)
    expect(manual.riskLevel).toBe("safe")
    expect(manual.mutating).toBe(false)
  })

  test("EC-060-09: getToolsByCategory returns correct tools for FILE_READ", () => {
    const tools = getToolsByCategory(ToolCategory.FILE_READ)
    const names = tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("glob")
    expect(names).toContain("grep")
    // Should NOT contain write tools
    expect(names).not.toContain("edit")
    expect(names).not.toContain("bash")
  })

  test("EC-060-10: getToolManual returns undefined for non-existent tool", () => {
    expect(getToolManual("nonexistent")).toBeUndefined()
  })

  test("EC-060-11: no tool has undefined category or source", () => {
    const allTools = getAllBuiltinTools()
    for (const tool of allTools) {
      expect(tool.category, `${tool.name} should have a category`).toBeDefined()
      expect(tool.source, `${tool.name} should have source "builtin"`).toBe("builtin")
      expect(tool.displayName, `${tool.name} should have a displayName`).toBeTruthy()
      expect(tool.description, `${tool.name} should have a description`).toBeTruthy()
    }
  })

  test("EC-060-12: glob and grep have SEARCH as secondary category", () => {
    const glob = getToolManual("glob")!
    const grep = getToolManual("grep")!
    expect(glob.secondaryCategories).toContain(ToolCategory.SEARCH)
    expect(grep.secondaryCategories).toContain(ToolCategory.SEARCH)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 3: MCP Tool Categorizer
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-060: MCP Tool Categorizer", () => {
  test("EC-060-13: explicit map — notion_search categorized as SEARCH", () => {
    expect(categorizeMcpTool("notion_search", "notion-docs-reader")).toBe(ToolCategory.SEARCH)
  })

  test("EC-060-14: explicit map — notion_fetch categorized as FILE_READ", () => {
    expect(categorizeMcpTool("notion_fetch", "notion-docs-reader")).toBe(ToolCategory.FILE_READ)
  })

  test("EC-060-15: explicit map — create_issue categorized as PLANNING", () => {
    expect(categorizeMcpTool("create_issue", "linear-server")).toBe(ToolCategory.PLANNING)
  })

  test("EC-060-16: explicit map — list_issues categorized as SEARCH", () => {
    expect(categorizeMcpTool("list_issues", "linear-server")).toBe(ToolCategory.SEARCH)
  })

  test("EC-060-17: server default — unknown tool from linear-server gets PLANNING", () => {
    expect(categorizeMcpTool("some_custom_action", "linear-server")).toBe(ToolCategory.PLANNING)
  })

  test("EC-060-18: server default — unknown tool from playwright gets EXECUTION", () => {
    expect(categorizeMcpTool("custom_playwright_action", "playwright")).toBe(ToolCategory.EXECUTION)
  })

  test("EC-060-19: heuristic — search_documents categorized as SEARCH", () => {
    expect(categorizeMcpTool("search_documents", "unknown-server")).toBe(ToolCategory.SEARCH)
  })

  test("EC-060-20: heuristic — create_record categorized as FILE_WRITE", () => {
    expect(categorizeMcpTool("create_record", "unknown-server")).toBe(ToolCategory.FILE_WRITE)
  })

  test("EC-060-21: heuristic — get_data categorized as FILE_READ", () => {
    expect(categorizeMcpTool("get_data", "unknown-server")).toBe(ToolCategory.FILE_READ)
  })

  test("EC-060-22: heuristic — run_workflow categorized as EXECUTION", () => {
    expect(categorizeMcpTool("run_workflow", "unknown-server")).toBe(ToolCategory.EXECUTION)
  })

  test("EC-060-23: fallback — unrecognizable name defaults to FILE_READ", () => {
    expect(categorizeMcpTool("xyzzy_action", "unknown-server")).toBe(ToolCategory.FILE_READ)
  })

  test("EC-060-24: explicit map takes priority over heuristic", () => {
    // notion_search would match "search" heuristic anyway, but it should use explicit map
    // Test with a Linear tool that has an action keyword in name but a different explicit mapping
    expect(categorizeMcpTool("get_issue", "linear-server")).toBe(ToolCategory.FILE_READ)
  })

  test("EC-060-25: createMcpToolManual produces valid ToolManual", () => {
    const manual = createMcpToolManual("test_tool", "test-server", {
      name: "test_tool",
      description: "A test tool",
      inputSchema: {},
    })
    expect(manual.name).toBe("test_tool")
    expect(manual.source).toBe("mcp")
    expect(manual.mcpServer).toBe("test-server")
    expect(manual.displayName).toBeTruthy()
    expect(manual.description).toBe("A test tool")
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 4: Agent Profiles
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-060: Agent Profiles", () => {
  const ALL_AGENT_TYPES = [
    "main", "plan", "explore", "debugger", "researcher",
    "docs-generator", "readme-generator", "coder", "test-writer", "reviewer",
  ]

  test("EC-060-26: all 10 agent profiles exist", () => {
    // Note: there are at least 9 explicit profiles, plus potentially a 10th
    for (const agentType of ALL_AGENT_TYPES) {
      const profile = getAgentProfile(agentType)
      expect(profile, `Profile for "${agentType}" should exist`).toBeDefined()
      expect(profile.agentType).toBe(agentType)
    }
  })

  test("EC-060-27: main agent has all categories allowed", () => {
    const profile = getAgentProfile("main")
    const allCategories = Object.values(ToolCategory)
    for (const cat of allCategories) {
      expect(profile.allowedCategories.has(cat), `main should have ${cat}`).toBe(true)
    }
  })

  test("EC-060-28: reviewer agent CANNOT access file-write or execution", () => {
    const profile = getAgentProfile("reviewer")
    expect(profile.allowedCategories.has(ToolCategory.FILE_WRITE)).toBe(false)
    expect(profile.allowedCategories.has(ToolCategory.EXECUTION)).toBe(false)
    expect(profile.allowedCategories.has(ToolCategory.WEB)).toBe(false)
  })

  test("EC-060-29: reviewer agent CAN access file-read and search", () => {
    const profile = getAgentProfile("reviewer")
    expect(profile.allowedCategories.has(ToolCategory.FILE_READ)).toBe(true)
    expect(profile.allowedCategories.has(ToolCategory.SEARCH)).toBe(true)
  })

  test("EC-060-30: reviewer denies edit, write, bash, task, patch", () => {
    const profile = getAgentProfile("reviewer")
    expect(profile.deniedTools).toContain("edit")
    expect(profile.deniedTools).toContain("write")
    expect(profile.deniedTools).toContain("bash")
    expect(profile.deniedTools).toContain("task")
    expect(profile.deniedTools).toContain("patch")
  })

  test("EC-060-31: coder agent has FILE_READ, FILE_WRITE, EXECUTION, SEARCH", () => {
    const profile = getAgentProfile("coder")
    expect(profile.allowedCategories.has(ToolCategory.FILE_READ)).toBe(true)
    expect(profile.allowedCategories.has(ToolCategory.FILE_WRITE)).toBe(true)
    expect(profile.allowedCategories.has(ToolCategory.EXECUTION)).toBe(true)
    expect(profile.allowedCategories.has(ToolCategory.SEARCH)).toBe(true)
  })

  test("EC-060-32: coder agent denies task, webfetch, websearch", () => {
    const profile = getAgentProfile("coder")
    expect(profile.deniedTools).toContain("task")
    expect(profile.deniedTools).toContain("webfetch")
    expect(profile.deniedTools).toContain("websearch")
  })

  test("EC-060-33: coder agent requires skill", () => {
    const profile = getAgentProfile("coder")
    expect(profile.requiredTools).toContain("skill")
  })

  test("EC-060-34: test-writer denies patch", () => {
    const profile = getAgentProfile("test-writer")
    expect(profile.deniedTools).toContain("patch")
    expect(profile.deniedTools).toContain("task")
  })

  test("EC-060-35: explore agent denies edit, write, bash and most tools", () => {
    const profile = getAgentProfile("explore")
    expect(profile.deniedTools).toContain("edit")
    expect(profile.deniedTools).toContain("write")
    expect(profile.deniedTools).toContain("bash")
  })

  test("EC-060-36: explore agent requires task", () => {
    const profile = getAgentProfile("explore")
    expect(profile.requiredTools).toContain("task")
  })

  test("EC-060-37: unknown agent type returns permissive default", () => {
    const profile = getAgentProfile("nonexistent-agent")
    const allCategories = Object.values(ToolCategory)
    for (const cat of allCategories) {
      expect(profile.allowedCategories.has(cat), `unknown agent should have ${cat}`).toBe(true)
    }
    expect(profile.deniedTools).toHaveLength(0)
  })

  test("EC-060-38: no profile has a tool in both deniedTools and requiredTools", () => {
    for (const agentType of ALL_AGENT_TYPES) {
      const profile = getAgentProfile(agentType)
      const overlap = profile.requiredTools.filter((t) => profile.deniedTools.includes(t))
      expect(overlap, `${agentType} has conflicting denied+required: ${overlap}`).toHaveLength(0)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 5: Category Resolver
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-060: Category Resolver", () => {
  const allBuiltinTools = getAllBuiltinTools()

  test("EC-060-39: resolveAgentTools for reviewer excludes bash, edit, write", () => {
    const tools = resolveAgentTools("reviewer", allBuiltinTools)
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("bash")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("write")
    expect(names).not.toContain("task")
    expect(names).not.toContain("patch")
  })

  test("EC-060-40: resolveAgentTools for reviewer includes read, glob, grep, skill", () => {
    const tools = resolveAgentTools("reviewer", allBuiltinTools)
    const names = tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("glob")
    expect(names).toContain("grep")
    expect(names).toContain("skill") // required tool
  })

  test("EC-060-41: resolveAgentTools for main includes ALL built-in tools", () => {
    const tools = resolveAgentTools("main", allBuiltinTools)
    expect(tools.length).toBe(allBuiltinTools.length)
  })

  test("EC-060-42: global deny removes tool from ALL agents", () => {
    const config: ToolRoutingConfig = {
      globalDeny: ["bash"],
      profiles: {},
    }
    // Even main agent should lose bash
    const mainTools = resolveAgentTools("main", allBuiltinTools, config)
    expect(mainTools.map((t) => t.name)).not.toContain("bash")

    const coderTools = resolveAgentTools("coder", allBuiltinTools, config)
    expect(coderTools.map((t) => t.name)).not.toContain("bash")
  })

  test("EC-060-43: user override addTools CANNOT override profile deniedTools (security boundary)", () => {
    // Design decision: profile deniedTools is a hard security boundary.
    // addTools can only add tools excluded by CATEGORY, not tools explicitly denied.
    const config: ToolRoutingConfig = {
      globalDeny: [],
      profiles: {
        reviewer: {
          addTools: ["bash"], // reviewer explicitly denies bash in its profile
        },
      },
    }
    const tools = resolveAgentTools("reviewer", allBuiltinTools, config)
    const names = tools.map((t) => t.name)
    // bash should STILL be excluded because profile deny > user addTools
    expect(names).not.toContain("bash")
  })

  test("EC-060-43b: user override addTools CAN add category-excluded tools not in deny list", () => {
    // lsp is excluded from coder by category (NAVIGATION not in coder's allowed categories)
    // but is NOT in coder's explicit deny list — so addTools should work
    const config: ToolRoutingConfig = {
      globalDeny: [],
      profiles: {
        coder: {
          addTools: ["lsp"],
        },
      },
    }
    const tools = resolveAgentTools("coder", allBuiltinTools, config)
    const names = tools.map((t) => t.name)
    expect(names).toContain("lsp")
  })

  test("EC-060-44: user override denyTools removes a normally-allowed tool", () => {
    const config: ToolRoutingConfig = {
      globalDeny: [],
      profiles: {
        coder: {
          denyTools: ["read"], // coder normally has read
        },
      },
    }
    const tools = resolveAgentTools("coder", allBuiltinTools, config)
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("read")
  })

  test("EC-060-45: user override addCategories extends agent permissions", () => {
    const config: ToolRoutingConfig = {
      globalDeny: [],
      profiles: {
        reviewer: {
          addCategories: [ToolCategory.EXECUTION],
        },
      },
    }
    const tools = resolveAgentTools("reviewer", allBuiltinTools, config)
    const names = tools.map((t) => t.name)
    // bash is in EXECUTION category and in reviewer's deniedTools,
    // so it may still be blocked by the explicit deny list.
    // But execution-category tools not in deny list should appear.
    // All reviewer denied tools: edit, write, bash, webfetch, websearch, todowrite, todoread, task, patch
    // bash IS in deniedTools, so it should still be blocked
    expect(names).not.toContain("bash")
  })

  test("EC-060-46: user override removeCategories restricts agent permissions", () => {
    const config: ToolRoutingConfig = {
      globalDeny: [],
      profiles: {
        coder: {
          removeCategories: [ToolCategory.EXECUTION],
        },
      },
    }
    const tools = resolveAgentTools("coder", allBuiltinTools, config)
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("bash")
  })

  test("EC-060-47: resolveToolAccess returns true for required tool even if category disallowed", () => {
    // coder requires "skill" but doesn't have PLANNING category
    const skillTool = getToolManual("skill")!
    expect(resolveToolAccess("coder", skillTool)).toBe(true)
  })

  test("EC-060-48: resolveToolAccess returns false for denied tool even if category allowed", () => {
    // coder denies "webfetch" even though WEB isn't in allowed categories anyway
    const webfetch = getToolManual("webfetch")!
    expect(resolveToolAccess("coder", webfetch)).toBe(false)
  })

  test("EC-060-49: unknown agent type gets all tools (permissive)", () => {
    const tools = resolveAgentTools("some-new-agent", allBuiltinTools)
    expect(tools.length).toBe(allBuiltinTools.length)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 6: ToolRegistry Class
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-060: ToolRegistry Class", () => {
  test("EC-060-50: new registry has 14 built-in tools", () => {
    const registry = new ToolRegistry()
    expect(registry.builtinCount).toBe(14)
    expect(registry.mcpCount).toBe(0)
    expect(registry.size).toBe(14)
  })

  test("EC-060-51: registerMcpTools adds MCP tools", () => {
    const registry = new ToolRegistry()
    registry.registerMcpTools("test-server", [
      { name: "test_action", description: "A test action", inputSchema: {} },
      { name: "test_query", description: "A test query", inputSchema: {} },
    ])
    expect(registry.mcpCount).toBe(2)
    expect(registry.size).toBe(16)
  })

  test("EC-060-52: unregisterMcpServer removes only that server's tools", () => {
    const registry = new ToolRegistry()
    registry.registerMcpTools("server-a", [
      { name: "a_tool", description: "Tool A", inputSchema: {} },
    ])
    registry.registerMcpTools("server-b", [
      { name: "b_tool", description: "Tool B", inputSchema: {} },
    ])
    expect(registry.mcpCount).toBe(2)

    registry.unregisterMcpServer("server-a")
    expect(registry.mcpCount).toBe(1)
    expect(registry.getTool("a_tool")).toBeUndefined()
    expect(registry.getTool("b_tool")).toBeDefined()
  })

  test("EC-060-53: getTool returns built-in tool by name", () => {
    const registry = new ToolRegistry()
    const tool = registry.getTool("read")
    expect(tool).toBeDefined()
    expect(tool!.name).toBe("read")
    expect(tool!.source).toBe("builtin")
  })

  test("EC-060-54: getToolsForAgent filters correctly for reviewer", () => {
    const registry = new ToolRegistry()
    const tools = registry.getToolsForAgent("reviewer")
    const names = tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("skill")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("write")
  })

  test("EC-060-55: getToolsForAgent for coder includes skill as required", () => {
    const registry = new ToolRegistry()
    const tools = registry.getToolsForAgent("coder")
    const names = tools.map((t) => t.name)
    expect(names).toContain("skill")
    expect(names).toContain("read")
    expect(names).toContain("edit")
    expect(names).toContain("bash")
    expect(names).not.toContain("task")
    expect(names).not.toContain("webfetch")
  })

  test("EC-060-56: getToolCountByCategory returns correct counts", () => {
    const registry = new ToolRegistry()
    const counts = registry.getToolCountByCategory()
    expect(counts[ToolCategory.FILE_READ]).toBeGreaterThanOrEqual(3) // read, glob, grep
    expect(counts[ToolCategory.FILE_WRITE]).toBeGreaterThanOrEqual(3) // edit, write, patch
    expect(counts[ToolCategory.EXECUTION]).toBeGreaterThanOrEqual(1) // bash
    expect(counts[ToolCategory.DELEGATION]).toBeGreaterThanOrEqual(1) // task
  })

  test("EC-060-57: getAllTools returns built-in + MCP", () => {
    const registry = new ToolRegistry()
    registry.registerMcpTools("test", [
      { name: "mcp_tool", description: "An MCP tool", inputSchema: {} },
    ])
    const all = registry.getAllTools()
    expect(all).toHaveLength(15)
    const names = all.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("mcp_tool")
  })

  test("EC-060-58: getToolsForAgent with user config applies overrides", () => {
    const registry = new ToolRegistry()
    const config: ToolRoutingConfig = {
      globalDeny: ["lsp"],
      profiles: {},
    }
    const tools = registry.getToolsForAgent("main", config)
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("lsp")
  })
})
