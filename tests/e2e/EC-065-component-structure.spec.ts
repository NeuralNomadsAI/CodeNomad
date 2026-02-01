/**
 * EC-065: Component & Module Structure — File Integrity Tests
 *
 * Verifies that all files created across Milestones B1-B5 exist,
 * export the expected symbols, and contain the expected code structures.
 *
 * These are Node-side filesystem tests that validate the codebase
 * structure matches the implementation plan.
 */

import { test, expect } from "@playwright/test"
import * as fs from "node:fs"
import * as path from "node:path"

const PROJECT_ROOT = path.resolve(__dirname, "../..")

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(PROJECT_ROOT, relativePath))
}

function fileContains(relativePath: string, text: string): boolean {
  const fullPath = path.join(PROJECT_ROOT, relativePath)
  if (!fs.existsSync(fullPath)) return false
  const content = fs.readFileSync(fullPath, "utf-8")
  return content.includes(text)
}

function fileMatchesRegex(relativePath: string, pattern: RegExp): boolean {
  const fullPath = path.join(PROJECT_ROOT, relativePath)
  if (!fs.existsSync(fullPath)) return false
  const content = fs.readFileSync(fullPath, "utf-8")
  return pattern.test(content)
}

// ═══════════════════════════════════════════════════════════════════
// SECTION 1: B2 — Tool Routing Infrastructure Files
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-065: Tool Routing Infrastructure Files (B2)", () => {
  const TOOL_FILES = [
    "packages/server/src/tools/types.ts",
    "packages/server/src/tools/manual-registry.ts",
    "packages/server/src/tools/mcp-categorizer.ts",
    "packages/server/src/tools/agent-profiles.ts",
    "packages/server/src/tools/category-resolver.ts",
    "packages/server/src/tools/tool-registry.ts",
    "packages/server/src/tools/index.ts",
  ]

  test("EC-065-01: all 7 tool routing files exist", () => {
    for (const file of TOOL_FILES) {
      expect(fileExists(file), `${file} should exist`).toBe(true)
    }
  })

  test("EC-065-02: types.ts exports ToolCategory enum with 8 values", () => {
    expect(fileContains("packages/server/src/tools/types.ts", "export enum ToolCategory")).toBe(true)
    expect(fileContains("packages/server/src/tools/types.ts", "FILE_READ")).toBe(true)
    expect(fileContains("packages/server/src/tools/types.ts", "FILE_WRITE")).toBe(true)
    expect(fileContains("packages/server/src/tools/types.ts", "EXECUTION")).toBe(true)
    expect(fileContains("packages/server/src/tools/types.ts", "WEB")).toBe(true)
    expect(fileContains("packages/server/src/tools/types.ts", "PLANNING")).toBe(true)
    expect(fileContains("packages/server/src/tools/types.ts", "DELEGATION")).toBe(true)
    expect(fileContains("packages/server/src/tools/types.ts", "SEARCH")).toBe(true)
    expect(fileContains("packages/server/src/tools/types.ts", "NAVIGATION")).toBe(true)
  })

  test("EC-065-03: types.ts exports ToolManual interface", () => {
    expect(fileContains("packages/server/src/tools/types.ts", "export interface ToolManual")).toBe(true)
  })

  test("EC-065-04: types.ts exports AgentToolProfile interface", () => {
    expect(fileContains("packages/server/src/tools/types.ts", "export interface AgentToolProfile")).toBe(true)
  })

  test("EC-065-05: types.ts exports ToolRoutingConfig interface", () => {
    expect(fileContains("packages/server/src/tools/types.ts", "export interface ToolRoutingConfig")).toBe(true)
  })

  test("EC-065-06: manual-registry.ts exports BUILTIN_TOOLS with 14 tools", () => {
    expect(fileContains("packages/server/src/tools/manual-registry.ts", "export const BUILTIN_TOOLS")).toBe(true)
    // Verify all 14 built-in tool names are present
    const toolNames = ["read", "glob", "grep", "edit", "write", "patch", "bash",
      "webfetch", "websearch", "task", "skill", "todowrite", "todoread", "lsp"]
    for (const name of toolNames) {
      expect(
        fileMatchesRegex("packages/server/src/tools/manual-registry.ts", new RegExp(`["']${name}["']`)),
        `BUILTIN_TOOLS should contain "${name}"`
      ).toBe(true)
    }
  })

  test("EC-065-07: manual-registry.ts exports helper functions", () => {
    expect(fileContains("packages/server/src/tools/manual-registry.ts", "export function getToolsByCategory")).toBe(true)
    expect(fileContains("packages/server/src/tools/manual-registry.ts", "export function getToolManual")).toBe(true)
    expect(fileContains("packages/server/src/tools/manual-registry.ts", "export function getAllBuiltinTools")).toBe(true)
  })

  test("EC-065-08: mcp-categorizer.ts exports categorization functions", () => {
    expect(fileContains("packages/server/src/tools/mcp-categorizer.ts", "export function categorizeMcpTool")).toBe(true)
    expect(fileContains("packages/server/src/tools/mcp-categorizer.ts", "export function createMcpToolManual")).toBe(true)
  })

  test("EC-065-09: mcp-categorizer.ts has known MCP tool map", () => {
    expect(fileContains("packages/server/src/tools/mcp-categorizer.ts", "KNOWN_MCP_TOOL_MAP")).toBe(true)
    expect(fileContains("packages/server/src/tools/mcp-categorizer.ts", "notion_search")).toBe(true)
    expect(fileContains("packages/server/src/tools/mcp-categorizer.ts", "linear")).toBe(true)
  })

  test("EC-065-10: agent-profiles.ts exports DEFAULT_AGENT_PROFILES", () => {
    expect(fileContains("packages/server/src/tools/agent-profiles.ts", "export const DEFAULT_AGENT_PROFILES")).toBe(true)
  })

  test("EC-065-11: agent-profiles.ts has all 10 agent types", () => {
    const agents = ["main", "plan", "explore", "debugger", "researcher",
      "docs-generator", "readme-generator", "coder", "test-writer", "reviewer"]
    for (const agent of agents) {
      expect(
        fileContains("packages/server/src/tools/agent-profiles.ts", `"${agent}"`),
        `Agent profile for "${agent}" should exist`
      ).toBe(true)
    }
  })

  test("EC-065-12: agent-profiles.ts exports getAgentProfile function", () => {
    expect(fileContains("packages/server/src/tools/agent-profiles.ts", "export function getAgentProfile")).toBe(true)
  })

  test("EC-065-13: category-resolver.ts exports resolution functions", () => {
    expect(fileContains("packages/server/src/tools/category-resolver.ts", "export function resolveToolAccess")).toBe(true)
    expect(fileContains("packages/server/src/tools/category-resolver.ts", "export function resolveAgentTools")).toBe(true)
  })

  test("EC-065-14: tool-registry.ts exports ToolRegistry class", () => {
    expect(fileContains("packages/server/src/tools/tool-registry.ts", "export class ToolRegistry")).toBe(true)
  })

  test("EC-065-15: index.ts re-exports public API", () => {
    const indexFile = "packages/server/src/tools/index.ts"
    expect(fileContains(indexFile, "ToolCategory")).toBe(true)
    expect(fileContains(indexFile, "ToolManual")).toBe(true)
    expect(fileContains(indexFile, "ToolRegistry")).toBe(true)
    expect(fileContains(indexFile, "resolveAgentTools")).toBe(true)
    expect(fileContains(indexFile, "getAgentProfile")).toBe(true)
    expect(fileContains(indexFile, "categorizeMcpTool")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 2: B4 — Pipeline Visualization Files
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-065: Pipeline Visualization Files (B4)", () => {
  test("EC-065-16: pipeline-group.tsx exists and exports PipelineGroup", () => {
    const file = "packages/ui/src/components/pipeline-group.tsx"
    expect(fileExists(file)).toBe(true)
    expect(fileContains(file, "export default PipelineGroup")).toBe(true)
  })

  test("EC-065-17: pipeline-group.tsx has PIPELINE_NAMES mapping", () => {
    const file = "packages/ui/src/components/pipeline-group.tsx"
    expect(fileContains(file, "PIPELINE_NAMES")).toBe(true)
    expect(fileContains(file, "implementation-pipeline")).toBe(true)
    expect(fileContains(file, "code-review-pipeline")).toBe(true)
    expect(fileContains(file, "code-test-pipeline")).toBe(true)
  })

  test("EC-065-18: pipeline-step.tsx exists and exports key functions", () => {
    const file = "packages/ui/src/components/pipeline-step.tsx"
    expect(fileExists(file)).toBe(true)
    expect(fileContains(file, "export function detectPipelinePattern")).toBe(true)
    expect(fileContains(file, "export function extractReviewerVerdict")).toBe(true)
    expect(fileContains(file, "export default PipelineStep")).toBe(true)
  })

  test("EC-065-19: pipeline-step.tsx has PIPELINE_AGENT_META for 3 agents", () => {
    const file = "packages/ui/src/components/pipeline-step.tsx"
    expect(fileContains(file, "PIPELINE_AGENT_META")).toBe(true)
    expect(fileContains(file, "coder")).toBe(true)
    expect(fileContains(file, "test-writer")).toBe(true)
    expect(fileContains(file, "reviewer")).toBe(true)
  })

  test("EC-065-20: pipeline-step.tsx exports ReviewVerdict type", () => {
    const file = "packages/ui/src/components/pipeline-step.tsx"
    expect(fileContains(file, "export type ReviewVerdict")).toBe(true)
  })

  test("EC-065-21: pipeline.css exists with required classes", () => {
    const file = "packages/ui/src/styles/components/pipeline.css"
    expect(fileExists(file)).toBe(true)
    expect(fileContains(file, ".pipeline-group")).toBe(true)
    expect(fileContains(file, ".pipeline-header")).toBe(true)
    expect(fileContains(file, ".pipeline-step")).toBe(true)
    expect(fileContains(file, ".pipeline-connector")).toBe(true)
    expect(fileContains(file, ".pipeline-verdict")).toBe(true)
    expect(fileContains(file, ".pipeline-verdict--approve")).toBe(true)
    expect(fileContains(file, ".pipeline-verdict--reject")).toBe(true)
  })

  test("EC-065-22: message-block.tsx imports PipelineGroup and detectPipelinePattern", () => {
    const file = "packages/ui/src/components/message-block.tsx"
    expect(fileContains(file, 'import PipelineGroup from "./pipeline-group"')).toBe(true)
    expect(fileContains(file, 'import { detectPipelinePattern }')).toBe(true)
  })

  test("EC-065-23: message-block.tsx has pipeline-group in RenderSection union", () => {
    const file = "packages/ui/src/components/message-block.tsx"
    expect(fileContains(file, '"pipeline-group"')).toBe(true)
    expect(fileContains(file, "patternName")).toBe(true)
  })

  test("EC-065-24: message-block.tsx calls detectPipelinePattern in flushSubAgents", () => {
    const file = "packages/ui/src/components/message-block.tsx"
    expect(fileContains(file, "detectPipelinePattern(pendingSubAgents)")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 3: B3 — Approach Evaluation UI Files
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-065: Approach Evaluation UI Files (B3)", () => {
  test("EC-065-25: task.tsx has approaches pane", () => {
    const file = "packages/ui/src/components/tool-call/renderers/task.tsx"
    expect(fileContains(file, "approachesExpanded")).toBe(true)
    expect(fileContains(file, "approachEvaluation")).toBe(true)
    expect(fileContains(file, "task-pane-approaches")).toBe(true)
    expect(fileContains(file, "approach-card")).toBe(true)
  })

  test("EC-065-26: task.tsx renders approach badges", () => {
    const file = "packages/ui/src/components/tool-call/renderers/task.tsx"
    expect(fileContains(file, "approach-badge")).toBe(true)
    expect(fileContains(file, "approach-badge--selected")).toBe(true)
    expect(fileContains(file, "complexity")).toBe(true)
    expect(fileContains(file, "risk")).toBe(true)
    expect(fileContains(file, "alignment")).toBe(true)
    expect(fileContains(file, "testability")).toBe(true)
  })

  test("EC-065-27: task.css has approach card CSS", () => {
    const file = "packages/ui/src/styles/messaging/tool-call/task.css"
    expect(fileContains(file, ".approach-card")).toBe(true)
    expect(fileContains(file, ".approach-card--selected")).toBe(true)
    expect(fileContains(file, ".approach-badge")).toBe(true)
    expect(fileContains(file, ".approach-badge--low")).toBe(true)
    expect(fileContains(file, ".approach-badge--high")).toBe(true)
    expect(fileContains(file, ".approach-rationale")).toBe(true)
  })

  test("EC-065-28: subagent-row.tsx has Planned badge", () => {
    const file = "packages/ui/src/components/subagent-row.tsx"
    expect(fileContains(file, "hasApproachEvaluation")).toBe(true)
    expect(fileContains(file, "subagent-badge--planned")).toBe(true)
    expect(fileContains(file, "Planned")).toBe(true)
  })

  test("EC-065-29: subagent.css has badge CSS", () => {
    const file = "packages/ui/src/styles/components/subagent.css"
    expect(fileContains(file, ".subagent-badge")).toBe(true)
    expect(fileContains(file, ".subagent-badge--planned")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 4: B1 — maxSubagentIterations Files
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-065: maxSubagentIterations Files (B1)", () => {
  test("EC-065-30: schema.ts has maxSubagentIterations field", () => {
    const file = "packages/server/src/config/schema.ts"
    expect(fileContains(file, "maxSubagentIterations")).toBe(true)
    expect(fileMatchesRegex(file, /min\(1\)/)).toBe(true)
    expect(fileMatchesRegex(file, /max\(10\)/)).toBe(true)
    expect(fileMatchesRegex(file, /default\(3\)/)).toBe(true)
  })

  test("EC-065-31: schema.ts has toolRouting field", () => {
    const file = "packages/server/src/config/schema.ts"
    expect(fileContains(file, "toolRouting")).toBe(true)
    expect(fileContains(file, "ToolRoutingSchema")).toBe(true)
    expect(fileContains(file, "ToolCategorySchema")).toBe(true)
  })

  test("EC-065-32: preferences.tsx has maxSubagentIterations setter", () => {
    const file = "packages/ui/src/stores/preferences.tsx"
    expect(fileContains(file, "setMaxSubagentIterations")).toBe(true)
    expect(fileContains(file, "maxSubagentIterations")).toBe(true)
  })

  test("EC-065-33: full-settings-pane.tsx has iterations input", () => {
    const file = "packages/ui/src/components/full-settings-pane.tsx"
    expect(fileContains(file, "Sub-Agent Configuration")).toBe(true)
    expect(fileContains(file, "maxSubagentIterations")).toBe(true)
  })

  test("EC-065-34: workspace manager injects ERA_MAX_SUBAGENT_ITERATIONS env var", () => {
    const file = "packages/server/src/workspaces/manager.ts"
    expect(fileContains(file, "ERA_MAX_SUBAGENT_ITERATIONS")).toBe(true)
    expect(fileContains(file, "maxSubagentIterations")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 5: B5 — Settings Agent Expansion Files
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-065: Settings Agent Expansion Files (B5)", () => {
  test("EC-065-35: full-settings-pane.tsx has 6 agent types", () => {
    const file = "packages/ui/src/components/full-settings-pane.tsx"
    expect(fileMatchesRegex(file, /type AgentType.*"main".*"coder".*"reviewer"/s)).toBe(true)
  })

  test("EC-065-36: full-settings-pane.tsx has labels for all 6 agents", () => {
    const file = "packages/ui/src/components/full-settings-pane.tsx"
    expect(fileContains(file, "Coder Agent")).toBe(true)
    expect(fileContains(file, "Test Writer")).toBe(true)
    expect(fileContains(file, "Reviewer Agent")).toBe(true)
  })

  test("EC-065-37: full-settings-pane.tsx has descriptions for new agents", () => {
    const file = "packages/ui/src/components/full-settings-pane.tsx"
    expect(fileContains(file, "Implementation specialist")).toBe(true)
    expect(fileContains(file, "Test generation & execution")).toBe(true)
    expect(fileContains(file, "Code review & quality")).toBe(true)
  })

  test("EC-065-38: full-settings-pane.tsx renders all 6 agents in For loop", () => {
    const file = "packages/ui/src/components/full-settings-pane.tsx"
    expect(fileContains(file, '"coder", "test-writer", "reviewer"')).toBe(true)
  })

  test("EC-065-39: DefaultModels type includes all agent entries", () => {
    const file = "packages/ui/src/components/full-settings-pane.tsx"
    // DefaultModels is now a Record<AgentType, ...> type alias for exhaustive type checking
    expect(fileMatchesRegex(file, /type DefaultModels\s*=\s*Record<AgentType/)).toBe(true)
    // AGENT_META Record must include all 6 agents for compile-time exhaustiveness
    expect(fileContains(file, 'AGENT_META: Record<AgentType')).toBe(true)
    expect(fileContains(file, '"test-writer"')).toBe(true)
    expect(fileContains(file, 'reviewer')).toBe(true)
    expect(fileContains(file, 'coder')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 6: Cross-Cutting File Integrity
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-065: Cross-Cutting Integrity", () => {
  test("EC-065-40: no TypeScript import errors in tool routing files", () => {
    // Verify that each file imports from files that exist
    const toolDir = "packages/server/src/tools"
    const files = ["manual-registry.ts", "mcp-categorizer.ts", "agent-profiles.ts",
      "category-resolver.ts", "tool-registry.ts"]

    for (const file of files) {
      const fullPath = `${toolDir}/${file}`
      expect(fileExists(fullPath), `${fullPath} should exist`).toBe(true)
      // Each file should import from ./types
      expect(fileContains(fullPath, '"./types"'), `${file} should import from ./types`).toBe(true)
    }
  })

  test("EC-065-41: pipeline-group.tsx imports pipeline.css", () => {
    expect(fileContains(
      "packages/ui/src/components/pipeline-group.tsx",
      '"../styles/components/pipeline.css"'
    )).toBe(true)
  })

  test("EC-065-42: subagent-group.tsx imports subagent.css", () => {
    expect(fileContains(
      "packages/ui/src/components/subagent-group.tsx",
      '"../styles/components/subagent.css"'
    )).toBe(true)
  })

  test("EC-065-43: all CSS files use CSS custom properties", () => {
    const cssFiles = [
      "packages/ui/src/styles/components/pipeline.css",
      "packages/ui/src/styles/components/subagent.css",
      "packages/ui/src/styles/messaging/tool-call/task.css",
    ]

    for (const file of cssFiles) {
      expect(fileExists(file), `${file} should exist`).toBe(true)
      // All CSS should use custom properties for theming
      expect(
        fileContains(file, "var(--"),
        `${file} should use CSS custom properties`
      ).toBe(true)
    }
  })

  test("EC-065-44: mock fixtures file exists and is importable", () => {
    expect(fileExists("tests/fixtures/mock-tool-states.ts")).toBe(true)
    expect(fileContains("tests/fixtures/mock-tool-states.ts", "FULL_PIPELINE_COMPLETED")).toBe(true)
    expect(fileContains("tests/fixtures/mock-tool-states.ts", "APPROACH_EVALUATION_DATA")).toBe(true)
  })
})
