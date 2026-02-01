# Agentic Reasoning Implementation Plan

## Two Linear Projects, Five Milestones Each

This plan covers changes across two repositories:
- **Project A: Era-Code Agent Pipeline v4.0** (`~/.era/era-code/`) -- Agent definitions, skills, commands
- **Project B: CodeNomad Sub-Agent Platform** (`~/CodeNomad/`) -- Config, UI, server infrastructure

---

## How the Agentic Coding Experience Changes

### Before (Current State)

A user asks the orchestrator to "add rate limiting to the API."

1. Orchestrator jumps straight to coding the first approach it thinks of
2. Writes code across 4 files with no structured evaluation of alternatives
3. May or may not run tests (depends on the LLM's judgment that day)
4. Returns the code to the user -- user discovers test failures themselves
5. All sub-agents receive the full 14+ tool definitions (~4,200 tokens wasted per sub-agent)
6. No iteration budget -- sub-agents can loop indefinitely or give up after 1 try
7. No review step -- code quality depends entirely on the orchestrator's self-review
8. The UI shows generic "sub-agent" rows with no pipeline context

### After (Target State)

Same request: "add rate limiting to the API."

1. Orchestrator loads the **approach-evaluation** skill, evaluates 3 approaches:
   - Token bucket middleware (LOW complexity, LOW risk, HIGH alignment)
   - Redis-backed distributed limiter (MED complexity, MED risk, MED alignment)
   - Custom sliding window (HIGH complexity, LOW risk, LOW alignment)
   - **SELECTED: Token bucket** -- matches existing Express middleware pattern
2. Orchestrator delegates to **coder** with the specification + approach evaluation
3. Coder implements the token bucket approach, following existing middleware patterns
4. Orchestrator delegates to **test-writer** -- writes unit + integration tests, runs them
5. Orchestrator delegates to **reviewer** -- produces structured review:
   - `VERDICT: APPROVE` (or REJECT with specific BLOCKER findings)
6. If REJECT: orchestrator sends findings back to coder, max 3 cycles
7. Orchestrator loads **code-validation** skill -- runs full build/lint/test suite
8. Code is returned to user with a structured validation report
9. Each sub-agent receives only the tools it needs (explore: 5 tools, not 14+)
10. The UI shows a connected **pipeline visualization**: Coder -> Test Writer -> Reviewer with APPROVE badge
11. The "Approaches" pane in the task renderer shows the 3 evaluated approaches with badges
12. The user can configure max iterations (1-10) in Settings > Era Code

---

# Project A: Era-Code Agent Pipeline v4.0

**Repository:** `~/.era/era-code/`
**Impact:** All behavioral changes. Pure markdown. No compilation. Immediate effect on restart.

## Milestone A1: Tool Routing (Immediate Win)

**Goal:** Add explicit `tools:` blocks to all subagent YAML frontmatter to restrict which tools each agent receives.

**User Story:** As a developer using Era Code, I want sub-agents to only receive the tools they need, so that context windows aren't filled with irrelevant tool definitions and agents can't accidentally use tools outside their role.

**Impact:** Saves 2,000-7,000+ tokens per sub-agent invocation. For a task spawning 5 sub-agents, that's 10,000-35,000 tokens saved.

### A1.1: Add tools block to explore.md

**File:** `opencode/agent/explore.md`
**Change:** Add `tools:` block to YAML frontmatter disabling: edit, write, bash, webfetch, websearch, todowrite, todoread, patch, skill
**Validation:** Start session, delegate to explore, verify it cannot call disabled tools; verify read/glob/grep/task still work

### A1.2: Add tools block to researcher.md

**File:** `opencode/agent/researcher.md`
**Change:** Add `tools:` block disabling: edit, write, todowrite, todoread, patch
**Validation:** Delegate research task, verify web/search/skill tools work, verify edit/write blocked

### A1.3: Add tools block to debugger.md

**File:** `opencode/agent/debugger.md`
**Change:** Add `tools:` block disabling: write, webfetch, websearch, todowrite, todoread, patch
**Validation:** Trigger `/era-debug`, verify read/edit/glob/grep/bash/task/skill work, others blocked

### A1.4: Add tools block to docs-generator.md and readme-generator.md

**Files:** `opencode/agent/docs-generator.md`, `opencode/agent/readme-generator.md`
**Change:** Add `tools:` block disabling: write, bash, webfetch, websearch, task, todowrite, todoread, patch, skill
**Validation:** Trigger `/era-readme`, verify read/edit/glob/grep work only

### A1.5: Add tools block to plan.md

**File:** `opencode/agent/plan.md`
**Change:** Add `tools:` block disabling: write, todowrite, todoread, patch
**Validation:** Start a plan session, verify read/glob/grep/webfetch/websearch/task/skill/edit(ask)/bash(ask) work

### A1.6: Version bump

**File:** `manifest.json`
**Change:** Bump version to 3.3.0
**Validation:** Verify all listed files exist on disk

---

## Milestone A2: New Skills

**Goal:** Create 4 new skills that power the validation loop, approach evaluation, code review, and test generation.

**User Story:** As a developer, I want my AI coding agent to validate code before returning it, evaluate approaches before coding, review its own output, and generate comprehensive tests -- so that code quality doesn't depend on the LLM's mood.

### A2.1: Create code-validation skill

**Files to create:**
- `opencode/skill/code-validation/SKILL.md`
- `opencode/skill/code-validation/references/framework-detection.md`
- `opencode/skill/code-validation/references/validation-checklist.md`

**Content spec (SKILL.md):**
- Frontmatter: `name: code-validation`, description referencing Iron Law
- Iron Law: `NO CODE RETURNS WITHOUT VALIDATION FIRST`
- Phase 1: Discovery -- detect test framework, linter, build system by scanning for package.json, Cargo.toml, go.mod, etc.
- Phase 2: Validate -- run type checking, linting, targeted tests, full test suite in order
- Phase 2b: Manual Review -- when no automation exists (syntax check, import check, self-review)
- Phase 3: Reflect/Fix -- 3-attempt limit, one fix at a time, re-run validation after each
- Phase 4: Report -- structured pass/fail/skip format
- Red Flags section (matching systematic-debugging pattern)
- Pre-Existing Failures section
- Quick Reference table

**Content spec (references/framework-detection.md):**
- Table: file pattern -> framework -> test command -> build command
- Covers: npm/yarn, Jest, Vitest, pytest, cargo, go, make

**Content spec (references/validation-checklist.md):**
- Pre-validation checks, per-language command cheatsheet, monorepo considerations

**Validation:**
1. Load skill in test session via skill tool -- verify it parses without error
2. Run against project WITH tests -- verify discovery and execution
3. Run against project WITHOUT tests -- verify graceful degradation to manual review
4. Introduce deliberate test failure -- verify 3-attempt limit and structured failure report

### A2.2: Create approach-evaluation skill

**Files to create:**
- `opencode/skill/approach-evaluation/SKILL.md`

**Content spec:**
- Frontmatter: `name: approach-evaluation`, description emphasizing non-interactive inline evaluation
- Differentiation from brainstorming (no dialogue, no docs/plans/ output, inline only)
- Process: understand requirement -> generate 2-3 approaches -> evaluate against criteria -> select and justify -> proceed
- Evaluation criteria: Complexity (LOW/MED/HIGH), Risk (LOW/MED/HIGH), Alignment (LOW/MED/HIGH), Testability (LOW/MED/HIGH)
- Structured output format with approach cards and SELECTED marker
- When NOT to evaluate: <20 lines, single file, obvious single approach

**Validation:**
1. Load skill, give it "add rate limiting to API" -- verify 2-3 approaches with badges
2. Verify it does NOT ask questions or attempt dialogue
3. Verify output follows structured format
4. Give it a trivial task ("fix typo") -- verify it skips evaluation

### A2.3: Create code-review skill

**Files to create:**
- `opencode/skill/code-review/SKILL.md`
- `opencode/skill/code-review/references/review-checklist.md`
- `opencode/skill/code-review/references/security-patterns.md`

**Content spec (SKILL.md):**
- Iron Law: `NO APPROVAL WITHOUT FULL REVIEW FIRST`
- Review checklist: Correctness, Style Consistency, Security, Test Coverage, Architecture
- Finding severities: BLOCKER, WARNING, SUGGESTION
- Rejection criteria: any BLOCKER = REJECT, 3+ WARNINGs = REJECT
- Structured verdict format with file:line references

**Content spec (references/security-patterns.md):**
- Common anti-patterns: hardcoded secrets, eval/exec, unsanitized input, SQL string concatenation, path traversal, command injection

**Validation:**
1. Present diff with known security issue -- verify REJECT with BLOCKER finding
2. Present clean diff -- verify APPROVE
3. Verify output follows structured verdict format

### A2.4: Create test-generation skill

**Files to create:**
- `opencode/skill/test-generation/SKILL.md`
- `opencode/skill/test-generation/references/test-patterns.md`
- `opencode/skill/test-generation/references/framework-templates.md`

**Content spec (SKILL.md):**
- Process: framework detection -> pattern analysis -> test planning -> test generation -> validation
- Coverage strategy: public API surface, error handling, state mutations, integration boundaries
- Anti-patterns: testing implementation not behavior, mocking everything, snapshot abuse

**Validation:**
1. Load skill, point at a function with no tests -- verify test generation
2. Verify generated tests match project's test framework and style
3. Verify tests actually run and pass

---

## Milestone A3: New Specialized Agents

**Goal:** Create 3 agents that form the implementation pipeline: coder, test-writer, reviewer.

**User Story:** As a developer, I want separate agents for coding, testing, and reviewing -- so that each role has focused instructions and constrained tools, producing higher quality output than a single monolithic agent.

### A3.1: Create coder.md

**File:** `opencode/agent/coder.md`
**Frontmatter:** mode: subagent, temp: 0.4, tools: task:false, webfetch:false, websearch:false, todowrite:false, todoread:false. Permission: read, edit, write, glob, grep, bash, patch, skill: allow
**Body:** Implementation specialist. Must load approach-evaluation skill for non-trivial work. Cannot test, review, or delegate. Returns code with summary.
**Depends on:** A2.2 (approach-evaluation skill)
**Validation:** Delegate feature task, verify approach evaluation happens, verify no test/review attempts, verify no delegation

### A3.2: Create test-writer.md

**File:** `opencode/agent/test-writer.md`
**Frontmatter:** mode: subagent, temp: 0.3, tools: task:false, webfetch:false, websearch:false, todowrite:false, todoread:false, patch:false. Permission: read, edit, write, glob, grep, bash, skill: allow
**Body:** Test specialist. Must load test-generation skill. Cannot modify production code. Must run tests after writing them.
**Depends on:** A2.4 (test-generation skill)
**Validation:** Delegate test writing task, verify production code untouched, verify tests generated and executed

### A3.3: Create reviewer.md

**File:** `opencode/agent/reviewer.md`
**Frontmatter:** mode: subagent, temp: 0.5, tools: edit:false, write:false, bash:false, webfetch:false, websearch:false, todowrite:false, todoread:false, task:false, patch:false. Permission: read, glob, grep, skill: allow
**Body:** Review specialist. Must load code-review skill. Read-only. Produces APPROVE/REJECT verdict with findings.
**Depends on:** A2.3 (code-review skill)
**Validation:** Delegate review task, verify no code modification attempts, verify structured verdict output

---

## Milestone A4: Orchestration Overhaul

**Goal:** Rewrite orchestration.md to use the full pipeline: approach evaluation -> coder -> test-writer -> reviewer -> validation.

**User Story:** As a developer, I want the orchestration agent to automatically coordinate the implementation pipeline -- planning, coding, testing, reviewing, and validating -- so that I get production-quality code without manually managing each step.

### A4.1: Rewrite orchestration.md

**File:** `opencode/agent/orchestration.md`
**Change:** Complete body rewrite. New sections:
1. **Code Quality** -- mandatory code-validation skill loading after any code change
2. **Pre-Implementation Planning** -- approach-evaluation triggers for non-trivial features
3. **Code Implementation Pipeline** -- Steps 1-6: Plan(optional) -> Implement(coder) -> Test(test-writer) -> Review(reviewer) -> Handle Verdict(max 3 rejection cycles) -> Validate(code-validation skill)
4. **Specialist Delegation Table** -- all 9 agent types with routing rules
5. **When to Skip** -- one-line fixes, config/doc changes, emergency hotfixes
6. **Iteration Budget** -- reference to ERA_MAX_SUBAGENT_ITERATIONS env var

**Depends on:** A1.1-A1.5, A2.1-A2.4, A3.1-A3.3 (all previous milestones)
**Validation:**
1. Ask orchestrator to implement a non-trivial feature -- verify full pipeline execution
2. Verify approach evaluation before coding
3. Verify coder -> test-writer -> reviewer sequence
4. Introduce a review rejection -- verify retry loop (max 3)
5. Verify code-validation runs after pipeline completion
6. Ask for a trivial one-line fix -- verify pipeline is skipped

### A4.2: Create era-validate command

**File:** `opencode/command/era-validate.md`
**Content:** `agent: orchestration`, loads code-validation skill against $ARGUMENTS
**Depends on:** A2.1
**Validation:** Run `/era-validate` in a project with tests, verify discovery and execution

### A4.3: Update manifest.json

**File:** `manifest.json`
**Change:** Add all 16 new files (3 agents, 1 command, 4 SKILL.md files, 8 reference files). Bump version to 4.0.0.
**Depends on:** All previous tickets
**Validation:** Cross-reference manifest entries against files on disk

---

## Milestone A5: Integration Testing

**Goal:** End-to-end validation of the complete pipeline across real projects.

### A5.1: Test pipeline on TypeScript project

**Validation:** Ask orchestrator to implement a feature in a TypeScript project with Jest tests. Verify: approach evaluation -> coder -> test-writer -> reviewer -> code-validation. All agents use restricted toolsets.

### A5.2: Test pipeline on project without tests

**Validation:** Ask orchestrator to implement a feature in a project with no test framework. Verify: graceful degradation in code-validation (manual review mode), test-writer identifies missing framework.

### A5.3: Test rejection loop

**Validation:** Instruct the orchestrator to implement something that will likely trigger reviewer rejection (e.g., "add a feature but don't handle errors"). Verify: reviewer REJECTs, coder receives findings, pipeline retries, max 3 cycles.

### A5.4: Test trivial task bypass

**Validation:** Ask orchestrator to "fix the typo on line 42." Verify: pipeline is NOT invoked, orchestrator fixes directly and runs validation.

---

# Project B: CodeNomad Sub-Agent Platform

**Repository:** `~/CodeNomad/`
**Impact:** Config schema, UI preferences, settings panel, task visualization, pipeline rendering.

## Milestone B1: maxSubagentIterations Setting

**Goal:** Add a configurable setting that controls sub-agent iteration limits, visible in the UI and propagated as an environment variable.

**User Story:** As an Era Code user, I want to configure how many times a sub-agent can retry before escalating -- so I can balance thoroughness against cost/latency.

### B1.1: Add maxSubagentIterations to PreferencesSchema

**File:** `packages/server/src/config/schema.ts`
**Change:** Add to PreferencesSchema: `maxSubagentIterations: z.number().int().min(1).max(10).default(3)`
**Testing:** Unit test: `PreferencesSchema.parse({})` returns `maxSubagentIterations: 3`. Values 0 and 11 fail validation.

### B1.2: Add to UI Preferences interface and defaults

**File:** `packages/ui/src/stores/preferences.tsx`
**Changes:**
1. Add `maxSubagentIterations: number` to Preferences interface
2. Add `maxSubagentIterations: 3` to defaultPreferences
3. Add normalization in normalizePreferences
4. Add `setMaxSubagentIterations(value)` setter with clamping (1-10)
5. Export via ConfigContextValue
**Testing:** Unit test: normalization of missing values, clamping of out-of-range values

### B1.3: Add Settings UI control

**File:** `packages/ui/src/components/full-settings-pane.tsx`
**Change:** Add "Sub-Agent Configuration" subsection in EraCodeSection with numeric input (min 1, max 10, step 1)
**Testing:** E2E: navigate to Settings > Era Code, verify input renders with value 3, change to 5, verify persistence

### B1.4: Inject ERA_MAX_SUBAGENT_ITERATIONS env var

**File:** `packages/server/src/workspaces/manager.ts`
**Change:** After line 130 where environment is constructed, add `ERA_MAX_SUBAGENT_ITERATIONS: String(preferences.maxSubagentIterations ?? 3)`
**Testing:** Unit test: create workspace, verify env var present. Integration: set to 5, launch workspace, verify spawned process receives "5"

---

## Milestone B2: UTCP-Inspired Tool Routing Infrastructure

**Goal:** Build a UTCP-inspired tool manual registry, agent profile system, and category-based resolver that controls which tools each agent type receives. This is the CodeNomad-side infrastructure that complements the era-code `tools:` YAML frontmatter (Milestone A1).

**User Story:** As an Era Code user, I want each specialized agent to receive only the tools relevant to its role -- so that context windows aren't bloated with irrelevant tool definitions, agents can't accidentally use tools outside their specialty, and I can audit/customize which tools each agent type has access to.

### Architecture: How UTCP Concepts Map to Our System

**What UTCP teaches us (and what we adopt):**
UTCP (Universal Tool Calling Protocol) introduces the concept of **Tool Manuals** -- rich metadata documents that describe not just a tool's API, but its category, risk level, resource requirements, and relationship to other tools. UTCP's discovery model uses manual-based lookup, NOT embedding similarity.

**What we DON'T adopt:**
- UTCP's HTTP-native direct invocation protocol (our tools are process-local, not remote APIs)
- UTCP's full client/server architecture (unnecessary -- tools are already accessible in the OpenCode runtime)
- Vector database storage (see rationale below)

### Why NOT a Vector Database

A vector DB would store tool descriptions as embeddings and use semantic similarity to retrieve "relevant" tools for a given agent prompt. This is wrong for our use case:

1. **Tool sets are small**: ~14 built-in tools + ~10-30 MCP tools per workspace = ~50 tools max. Linear scan with category filtering is O(n) where n < 50. Sub-millisecond.
2. **Determinism matters**: Tool access must be deterministic and auditable. "The reviewer NEVER gets edit" is a hard constraint, not a soft relevance score. Vector similarity would sometimes include tools with close-but-wrong semantics.
3. **Categories are finite**: 8 categories cover the entire tool space. Category membership is a boolean, not a gradient.
4. **No cold-start problem**: We know all tools in advance. There's no need to "discover" tools from an open-ended corpus.
5. **Auditability**: Governance requires explaining exactly WHY a tool was included or excluded. "cosine similarity was 0.78" is not an auditable governance decision.

**Instead, we use: Static registry + category-based filtering + deterministic resolution.**

### Storage Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Tool Manual Registry                         │
│                   (In-memory, per CodeNomad server)                 │
│                                                                     │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐ │
│  │ Built-in Tool Manuals (14)   │  │ MCP Tool Manuals (dynamic)   │ │
│  │ ─────────────────────────    │  │ ─────────────────────────    │ │
│  │ • Static TypeScript objects  │  │ • Discovered at MCP connect  │ │
│  │ • Always available           │  │ • Enriched with category     │ │
│  │ • Categories pre-assigned    │  │   metadata via mapping table │ │
│  │ • Compiled into server       │  │ • Rebuilt per workspace      │ │
│  │                              │  │ • Ephemeral (not persisted)  │ │
│  └──────────────────────────────┘  └──────────────────────────────┘ │
│                                                                     │
│  Storage: NONE (in-memory objects). Rebuilt on server/workspace     │
│  start. No database, no file cache, no vector store.               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     Agent Profiles (Static)                         │
│              (TypeScript constants, compiled into server)           │
│                                                                     │
│  Each profile declares:                                             │
│  • allowedCategories: Set<ToolCategory>                             │
│  • deniedTools: string[]     (explicit blocklist, overrides all)    │
│  • requiredTools: string[]   (always included regardless of cat)    │
│  • maxToolCount?: number     (optional cap for context budget)      │
│                                                                     │
│  Storage: Code constants in agent-profiles.ts. Not configurable    │
│  at runtime (defaults). User overrides stored in preferences.      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                   User Overrides (Persistent)                       │
│              (Zod schema in PreferencesSchema)                      │
│                                                                     │
│  toolRouting: {                                                     │
│    globalDeny: string[]            // Tools denied to ALL agents    │
│    profiles: {                                                      │
│      [agentType]: {                                                 │
│        addCategories?: ToolCategory[]   // Grant extra categories   │
│        removeCategories?: ToolCategory[] // Revoke categories       │
│        addTools?: string[]              // Whitelist specific tools │
│        denyTools?: string[]             // Blacklist specific tools │
│      }                                                              │
│    }                                                                │
│  }                                                                  │
│                                                                     │
│  Storage: JSON in user preferences file. Persisted across sessions.│
│  Validated by Zod schema at load time.                             │
└─────────────────────────────────────────────────────────────────────┘
```

### MCP Server Lifecycle (NOT Constantly Running)

MCP servers are **NOT constantly running**. They follow an on-demand lifecycle:

```
User opens workspace
        │
        ▼
┌───────────────────────┐
│ Workspace starts      │
│ OpenCode process      │
│ spawns on random port │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐     ┌─────────────────────────────────┐
│ Built-in tools        │────▶│ Tool Registry populated with    │
│ registered immediately│     │ 14 built-in tool manuals        │
└───────────────────────┘     └─────────────────────────────────┘
            │
            ▼
┌───────────────────────┐     ┌─────────────────────────────────┐
│ MCP servers connect   │────▶│ For each connected server:      │
│ (mcpDesiredState=true)│     │ 1. tools/list → discover tools  │
│                       │     │ 2. Categorize each tool         │
│ Local: process spawns │     │ 3. Create ToolManual objects    │
│ Remote: HTTP connects │     │ 4. Add to registry              │
└───────────────────────┘     └─────────────────────────────────┘
            │
            ▼
┌───────────────────────┐     ┌─────────────────────────────────┐
│ Agent session starts  │────▶│ resolveAgentTools() called:     │
│ (e.g., coder agent)   │     │ 1. Load agent profile           │
│                       │     │ 2. Filter registry by category  │
│                       │     │ 3. Apply user overrides         │
│                       │     │ 4. Return filtered tool list    │
└───────────────────────┘     └─────────────────────────────────┘
            │
            ▼
    [Agent runs with restricted tool set]
            │
            ▼
┌───────────────────────┐
│ Workspace closes      │
│ MCP servers disconnect│
│ Registry discarded    │
└───────────────────────┘
```

**Key lifecycle details:**
- **Local MCP servers** (e.g., notion-docs-reader, playwright): A child process is spawned when the server connects. It runs for the lifetime of the workspace. When the workspace closes, the process is killed.
- **Remote MCP servers** (e.g., linear): An HTTP/SSE connection is opened. No process spawned. Connection dropped on workspace close.
- **Built-in tools** (read, edit, bash, etc.): Always available. Part of the OpenCode runtime. Not MCP-based at all.
- **Registry rebuild**: The tool registry is rebuilt from scratch each time a workspace starts. There is nothing to persist -- built-in tools are static, and MCP tools are re-discovered.

### Tool Retrieval for a Given Agent

When an agent session is created (e.g., orchestrator delegates to "coder"), the tool retrieval works as follows:

```
Input: agentType = "coder"
       fullRegistry = [14 built-in + N MCP tools]
       userOverrides = preferences.toolRouting

Step 1: Load agent profile
        coderProfile = {
          allowedCategories: [file-read, file-write, execution, search],
          deniedTools: ["task", "webfetch", "websearch", "todowrite", "todoread"],
          requiredTools: ["skill"],
          maxToolCount: undefined
        }

Step 2: Category filter
        For each tool in fullRegistry:
          if tool.category IN coderProfile.allowedCategories → INCLUDE
          else → EXCLUDE

        Result: read, edit, write, glob, grep, bash, patch (from built-in)
                + any MCP tools in those categories

Step 3: Explicit deny
        Remove any tool in coderProfile.deniedTools
        Remove any tool in userOverrides.globalDeny
        Remove any tool in userOverrides.profiles["coder"]?.denyTools

        Result: read, edit, write, glob, grep, bash, patch, skill
                (task, webfetch, websearch, todowrite, todoread removed)

Step 4: Explicit require
        Add any tool in coderProfile.requiredTools regardless of category
        Add any tool in userOverrides.profiles["coder"]?.addTools

        Result: read, edit, write, glob, grep, bash, patch, skill
                (skill added back via requiredTools even though it's in "planning" category)

Step 5: User category overrides
        If userOverrides.profiles["coder"]?.addCategories includes "web":
          Add webfetch, websearch back in
        If userOverrides.profiles["coder"]?.removeCategories includes "execution":
          Remove bash

Output: Final tool list passed to OpenCode agent session
```

### MCP Tool Categorization

When MCP tools are discovered via `tools/list`, they need category assignment. Three strategies, applied in priority order:

1. **Explicit mapping table** (highest priority): A static map of known MCP tool names to categories. E.g., `notion_search → search`, `notion_fetch → file-read`, `linear_create_issue → planning`.

2. **Server-level default category**: Each MCP server config can declare a `defaultCategory`. All tools from that server inherit it unless explicitly mapped. E.g., `linear-server → planning`, `playwright → execution`.

3. **Heuristic fallback**: If unmapped, tools are assigned based on name pattern matching:
   - Names containing `search`, `find`, `list`, `query` → `search`
   - Names containing `create`, `write`, `update`, `delete` → `file-write`
   - Names containing `read`, `get`, `fetch`, `view` → `file-read`
   - Names containing `run`, `execute`, `invoke` → `execution`
   - Default: `file-read` (safest default -- read-only)

### How This Relates to Era-Code Agent YAML (Milestone A1)

The CodeNomad tool routing infrastructure (B2) and the era-code `tools:` YAML frontmatter (A1) are **complementary layers** that serve different purposes:

| Aspect | Era-Code `tools:` (A1) | CodeNomad Routing (B2) |
|--------|------------------------|------------------------|
| **Where** | Agent markdown frontmatter | Server-side TypeScript |
| **Scope** | Built-in OpenCode tools only | Built-in + MCP tools |
| **Mechanism** | `tools: { edit: false }` prevents tool from being sent to LLM | Category-based filtering + profile resolution |
| **Who controls** | Era-Code maintainer (markdown files) | User (via Settings UI) + defaults |
| **When applied** | At OpenCode agent load time | At workspace/session start |
| **Relationship** | Sets the BASELINE tool access | Provides OVERRIDE capability + MCP routing |

**In practice:**
- A1 defines the baseline: "the coder agent should never have webfetch"
- B2 enables the user to customize: "actually, I want my coder to have web access for API docs"
- B2 also handles MCP tools, which A1 cannot address (A1 only knows about built-in tools)
- Both layers agree: the intersection of A1 permissions and B2 filtering determines the final tool set

### Tickets

### B2.1: Create tool types and ToolManual interface

**File to create:** `packages/server/src/tools/types.ts`
**Content:**
```typescript
// UTCP-inspired tool categories
enum ToolCategory {
  FILE_READ = "file-read",       // read, glob, grep
  FILE_WRITE = "file-write",     // edit, write, patch
  EXECUTION = "execution",       // bash
  WEB = "web",                   // webfetch, websearch
  PLANNING = "planning",         // todowrite, todoread, skill
  DELEGATION = "delegation",     // task
  SEARCH = "search",             // grep, glob (secondary)
  NAVIGATION = "navigation",     // LSP operations
}

// UTCP Tool Manual: rich metadata for each tool
interface ToolManual {
  name: string;                  // Unique identifier (e.g., "read", "notion_search")
  displayName: string;           // Human-readable name
  description: string;           // What the tool does
  category: ToolCategory;        // Primary category
  secondaryCategories?: ToolCategory[];  // Additional categories
  source: "builtin" | "mcp";    // Where the tool comes from
  mcpServer?: string;            // MCP server name (if source=mcp)
  riskLevel: "safe" | "moderate" | "dangerous";
  mutating: boolean;             // Does it modify state?
  tokenCost: "low" | "medium" | "high";  // Approximate context cost
}

// Agent tool profile: what an agent type can access
interface AgentToolProfile {
  agentType: string;
  allowedCategories: Set<ToolCategory>;
  deniedTools: string[];         // Explicit blocklist
  requiredTools: string[];       // Always included
  maxToolCount?: number;         // Optional context budget cap
}

// User-configurable overrides
interface ToolRoutingConfig {
  globalDeny: string[];
  profiles: Record<string, {
    addCategories?: ToolCategory[];
    removeCategories?: ToolCategory[];
    addTools?: string[];
    denyTools?: string[];
  }>;
}
```
**Testing:** TypeScript compilation + unit test: construct valid instances of each type

### B2.2: Create built-in tool manual registry

**File to create:** `packages/server/src/tools/manual-registry.ts`
**Content:** `BUILTIN_TOOLS` record mapping all 14 built-in tool names to `ToolManual` objects:

| Tool | Category | Risk | Mutating | Token Cost |
|------|----------|------|----------|------------|
| read | file-read | safe | no | low |
| glob | file-read + search | safe | no | low |
| grep | file-read + search | safe | no | low |
| edit | file-write | moderate | yes | medium |
| write | file-write | moderate | yes | medium |
| patch | file-write | moderate | yes | medium |
| bash | execution | dangerous | yes | high |
| webfetch | web | moderate | no | high |
| websearch | web | moderate | no | medium |
| task | delegation | safe | no | high |
| skill | planning | safe | no | low |
| todowrite | planning | safe | yes | low |
| todoread | planning | safe | no | low |
| lsp | navigation | safe | no | low |

Also: `getToolsByCategory(category)`, `getToolManual(name)`, `getAllTools()` helper functions.

**Testing:** Unit tests: all 14 tools registered, `getToolsByCategory("file-read")` returns [read, glob, grep], `getToolManual("bash").riskLevel === "dangerous"`, `getToolManual("nonexistent")` returns undefined

### B2.3: Create MCP tool categorizer

**File to create:** `packages/server/src/tools/mcp-categorizer.ts`
**Content:**
- `KNOWN_MCP_TOOL_MAP`: Static map of known MCP tool names to categories (e.g., `notion_search → search`, `notion_fetch → file-read`, `list_issues → search`, `create_issue → planning`)
- `SERVER_DEFAULT_CATEGORIES`: Map of MCP server names to default category (e.g., `linear-server → planning`, `playwright → execution`, `notion-docs-reader → file-read`)
- `categorizeMcpTool(toolName, serverName, toolDescription?)`: Returns `ToolCategory` using the 3-strategy priority system (explicit map > server default > heuristic)
- `createMcpToolManual(toolName, serverName, mcpToolDefinition)`: Creates a `ToolManual` from MCP `tools/list` response data + categorization

**Testing:** Unit tests:
- Known tool: `categorizeMcpTool("notion_search", "notion-docs-reader")` → `search`
- Server default: `categorizeMcpTool("unknown_tool", "linear-server")` → `planning`
- Heuristic: `categorizeMcpTool("search_documents", "new-server")` → `search`
- Heuristic: `categorizeMcpTool("create_record", "new-server")` → `file-write`
- Fallback: `categorizeMcpTool("do_something", "new-server")` → `file-read`

### B2.4: Create agent profiles registry

**File to create:** `packages/server/src/tools/agent-profiles.ts`
**Content:** `DEFAULT_AGENT_PROFILES` record for all 10 agent types:

| Agent Type | Allowed Categories | Denied Tools | Required Tools |
|------------|-------------------|--------------|----------------|
| main (orchestration) | ALL | none | skill |
| plan | file-read, search, web, planning, delegation, navigation | write, todowrite, todoread, patch | skill |
| explore | file-read, search, navigation | edit, write, bash, webfetch, websearch, todowrite, todoread, patch, skill | task |
| debugger | file-read, file-write, execution, search, navigation | write, webfetch, websearch, todowrite, todoread, patch | skill |
| researcher | file-read, search, web, delegation, navigation | edit, write, todowrite, todoread, patch | skill |
| docs-generator | file-read, file-write, search | write, bash, webfetch, websearch, task, todowrite, todoread, patch, skill | - |
| readme-generator | file-read, file-write, search | write, bash, webfetch, websearch, task, todowrite, todoread, patch, skill | - |
| coder | file-read, file-write, execution, search | task, webfetch, websearch, todowrite, todoread | skill |
| test-writer | file-read, file-write, execution, search | task, webfetch, websearch, todowrite, todoread, patch | skill |
| reviewer | file-read, search, navigation | edit, write, bash, webfetch, websearch, todowrite, todoread, task, patch | skill |

Also: `getAgentProfile(agentType)` function with fallback to "all allowed" for unknown types.

**Testing:** Unit tests:
- All 10 profiles exist and are valid
- `getAgentProfile("reviewer").allowedCategories` does NOT include `file-write`
- `getAgentProfile("coder").deniedTools` includes `task`
- `getAgentProfile("unknown")` returns permissive default
- No profile has conflicting denied + required tools

### B2.5: Create category resolver

**File to create:** `packages/server/src/tools/category-resolver.ts`
**Content:**
- `resolveToolAccess(agentType, toolName, registry, config?)`: Returns boolean -- should this agent have this tool?
- `resolveAgentTools(agentType, registry, config?)`: Returns `ToolManual[]` -- full filtered tool list for this agent
- Resolution logic (5 steps as described in "Tool Retrieval for a Given Agent" above)

**Testing:** Unit tests:
- Global deny: tool in `config.globalDeny` → blocked for ALL agents
- Category allow: tool in allowed category → included
- Category deny: tool NOT in allowed category → excluded
- Explicit deny: tool in profile `deniedTools` → excluded even if category matches
- Explicit require: tool in profile `requiredTools` → included even if category doesn't match
- User override addCategories: extends base profile
- User override removeCategories: restricts base profile
- User override addTools: whitelists specific tool
- User override denyTools: blacklists specific tool
- Unknown tool: defaults to included (permissive for new MCP tools)
- Unknown agent: defaults to all allowed

### B2.6: Create ToolRegistry class

**File to create:** `packages/server/src/tools/tool-registry.ts`
**Content:**
```typescript
class ToolRegistry {
  private builtinTools: Map<string, ToolManual>;
  private mcpTools: Map<string, ToolManual>;

  constructor() {
    // Load built-in tools from manual-registry
  }

  // Called when MCP server connects and returns tools/list
  registerMcpTools(serverName: string, mcpToolDefinitions: McpToolDef[]): void;

  // Called when MCP server disconnects
  unregisterMcpServer(serverName: string): void;

  // Get all registered tools (built-in + MCP)
  getAllTools(): ToolManual[];

  // Get tools filtered for a specific agent type
  getToolsForAgent(agentType: string, config?: ToolRoutingConfig): ToolManual[];

  // Get tool count by category (for UI display)
  getToolCountByCategory(): Record<ToolCategory, number>;
}
```

**Testing:** Unit tests:
- `new ToolRegistry()` has 14 built-in tools
- `registerMcpTools("linear", [...])` adds MCP tools
- `unregisterMcpServer("linear")` removes only linear's tools
- `getToolsForAgent("reviewer")` returns read-only tools
- `getToolsForAgent("coder")` returns file + execution tools but not web/delegation
- `getAllTools().length` === 14 + N_MCP after registration

### B2.7: Add toolRouting to PreferencesSchema

**File:** `packages/server/src/config/schema.ts`
**Change:** Add Zod schemas for the user-configurable overrides:
```typescript
const ToolCategorySchema = z.enum([
  "file-read", "file-write", "execution", "web",
  "planning", "delegation", "search", "navigation"
]);

const AgentToolOverrideSchema = z.object({
  addCategories: z.array(ToolCategorySchema).optional(),
  removeCategories: z.array(ToolCategorySchema).optional(),
  addTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
}).optional();

const ToolRoutingSchema = z.object({
  globalDeny: z.array(z.string()).default([]),
  profiles: z.record(z.string(), AgentToolOverrideSchema).default({}),
});

// Add to PreferencesSchema:
toolRouting: ToolRoutingSchema.default({})
```

**Testing:** Unit tests:
- `PreferencesSchema.parse({})` includes `toolRouting` with empty `globalDeny` and `profiles`
- Valid override with `addCategories: ["web"]` parses successfully
- Invalid category `"invalid-cat"` fails Zod validation
- Nested profile structure parses correctly

### B2.8: Create barrel export

**File to create:** `packages/server/src/tools/index.ts`
**Content:** Re-export all public APIs: ToolCategory, ToolManual, AgentToolProfile, ToolRoutingConfig, ToolRegistry, resolveAgentTools, getAgentProfile, BUILTIN_TOOLS, categorizeMcpTool
**Testing:** Import test from consuming module

---

## Milestone B3: Approach Evaluation UI

**Goal:** Render approach evaluation data from task metadata in a 4th task pane.

**User Story:** As an Era Code user, I want to see which implementation approaches were evaluated before coding started -- so I can understand why the agent chose a particular path and suggest alternatives if needed.

### B3.1: Add Approaches pane to task renderer

**File:** `packages/ui/src/components/tool-call/renderers/task.tsx`
**Changes:**
1. Add `approachesExpanded` signal
2. Add `approaches` memo extracting `approachEvaluation` from metadata
3. Add inline `ApproachCard` component with complexity/risk/alignment badges
4. Insert Approaches pane JSX between Prompt and Steps panes (conditionally rendered)
**Testing:** Manual test with mock metadata. E2E: inject session with approach data, verify pane appears with cards.

### B3.2: Add approach card and badge CSS

**File:** `packages/ui/src/styles/messaging/tool-call/task.css`
**Change:** Append CSS for `.approach-card`, `.approach-card--selected`, `.approach-badge`, `.approach-badge--{low,medium,high}` using existing CSS custom properties
**Testing:** Visual inspection in both light and dark themes

### B3.3: Add "Planned" badge to SubAgentRow

**File:** `packages/ui/src/components/subagent-row.tsx`
**Change:** Extract `hasApproachEvaluation` from metadata in taskInfo memo, render "Planned" badge when present
**CSS:** Add `.subagent-badge--planned` to `subagent.css`
**Testing:** Visual inspection with and without approach metadata

---

## Milestone B4: Pipeline Visualization

**Goal:** Detect and visually group consecutive coder -> test-writer -> reviewer task tools as a connected pipeline.

**User Story:** As an Era Code user, I want to see the implementation pipeline as a connected flow (Code -> Test -> Review) with a clear APPROVE/REJECT outcome -- so I understand the quality assurance process the agent performed.

### B4.1: Pipeline pattern detection

**File:** `packages/ui/src/components/message-block.tsx`
**Changes:**
1. Add `"pipeline-group"` to RenderSection union type
2. Add `detectPipelinePattern()` function checking for known agent sequences (coder -> test-writer -> reviewer)
3. Update `flushSubAgents()` to check for pipeline before defaulting to subagent-group
4. Add rendering branch for pipeline-group in renderSection
**Testing:** Unit test: detectPipelinePattern with correct sequence returns pattern name, wrong order returns null, partial sequence returns null

### B4.2: Create PipelineGroup component

**File to create:** `packages/ui/src/components/pipeline-group.tsx`
**Content:** Collapsible container showing connected pipeline steps. Header with pipeline name and overall status. Uses SubAgentRow for individual steps. Shows APPROVE/REJECT badge for reviewer step.
**Testing:** Visual test with mock 3-step pipeline, test collapse/expand

### B4.3: Create PipelineStep component

**File to create:** `packages/ui/src/components/pipeline-step.tsx`
**Content:** Individual step within pipeline showing type icon, name, status indicator, connecting line to next step. Reviewer verdict extraction logic (regex for APPROVE/REJECT in output).
**Testing:** Unit test: extractReviewerVerdict for APPROVE, REJECT, ambiguous outputs

### B4.4: Pipeline CSS

**File to create:** `packages/ui/src/styles/components/pipeline.css`
**Content:** `.pipeline-group`, `.pipeline-header`, `.pipeline-steps`, `.pipeline-step`, `.pipeline-connector`, `.pipeline-verdict`, `.pipeline-status` using existing design system variables
**Testing:** Visual inspection in both themes

### B4.5: Wire up imports

**File:** `packages/ui/src/components/message-block.tsx`
**Change:** Import PipelineGroup component, ensure pipeline.css loaded
**Testing:** Full integration test with session containing consecutive coder+test-writer+reviewer tools

---

## Milestone B5: Settings Panel Agent Expansion

**Goal:** Extend the per-agent model selection to include the 3 new agents.

**User Story:** As an Era Code user, I want to configure which LLM model each specialized agent uses -- so I can use a faster/cheaper model for the coder and a smarter model for the reviewer.

### B5.1: Extend AgentType union

**File:** `packages/ui/src/components/full-settings-pane.tsx`
**Change:** `type AgentType = "main" | "plan" | "explore" | "coder" | "test-writer" | "reviewer"`. Update DefaultModels interface and defaultModels memo with new entries.
**Testing:** E2E: all 6 agents appear in Models settings

### B5.2: Add agent metadata and descriptions

**File:** `packages/ui/src/components/full-settings-pane.tsx`
**Change:** Add AGENT_META record with descriptions, subtitles for each agent type. Render descriptions under model selector rows.
**Testing:** Visual inspection that all 6 agents render with descriptions

---

# Cross-Project Dependencies

```
Era-Code (Project A)              CodeNomad (Project B)
========================          ========================
A1: Tool Routing ──────────────── (no CodeNomad dependency)
A2: Skills ────────────────────── (no CodeNomad dependency)
A3: Agents ────────────────────── (no CodeNomad dependency)
A4: Orchestration ─────────────── B1.4 (env var for iterations)
A5: Integration Testing ───────── B3, B4 (UI rendering)

B1: maxSubagentIterations ─────── A4.1 (orchestration reads the env var)
B2: Tool Routing Infra ────────── A1 (validates same tool categories)
B3: Approach Evaluation UI ────── A2.2 (metadata format from skill)
B4: Pipeline Visualization ────── A3 (agent names for pattern detection)
B5: Agent Expansion ───────────── A3 (agent types to include)
```

**Recommended execution order:**
1. **A1 + A2** (parallel) -- Pure markdown, no code, immediate token savings + skill foundations
2. **B1** -- Config schema + UI + env var (small, self-contained)
3. **A3** -- New agents (depends on A2 skills)
4. **A4** -- Orchestration overhaul (depends on everything in A)
5. **B2** -- Tool routing infra (independent of A, foundational)
6. **B3 + B4** (parallel) -- UI rendering (depends on A3/A4 for metadata format)
7. **B5** -- Settings expansion (depends on A3 for agent names)
8. **A5** -- Integration testing (depends on everything)

---

# Total Scope

| Category | New Files | Modified Files |
|----------|-----------|----------------|
| Era-Code agents | 3 | 7 (6 tool blocks + orchestration rewrite) |
| Era-Code skills | 4 SKILL.md + 8 references | 0 |
| Era-Code commands | 1 | 0 |
| Era-Code manifest | 0 | 1 |
| CodeNomad server | 7 (tools/ directory: types, manual-registry, mcp-categorizer, agent-profiles, category-resolver, tool-registry, index) | 2 (schema.ts, manager.ts) |
| CodeNomad UI | 3 (pipeline components) | 4 (preferences, settings, task renderer, message-block) |
| CodeNomad CSS | 1 (pipeline.css) | 2 (task.css, subagent.css) |
| **Total** | **27 new files** | **16 modified files** |

**Era-Code tickets:** 17 across 5 milestones
**CodeNomad tickets:** 20 across 5 milestones (B2 expanded from 6 to 8 tickets)
**Grand total:** 37 tickets
