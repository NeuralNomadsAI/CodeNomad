/**
 * Mock ToolState and ToolDisplayItem data for testing pipeline detection,
 * approaches pane rendering, and subagent visualization.
 *
 * These fixtures simulate real tool call state payloads from the OpenCode SDK.
 */

// --- Type stubs (matching the subset of @opencode-ai/sdk used by our code) ---

export interface MockToolState {
  status: "pending" | "running" | "completed" | "error"
  input?: string
  output?: string
  metadata?: Record<string, unknown>
}

export interface MockToolCallPart {
  type: "tool"
  id?: string
  tool?: string
  state?: MockToolState
}

export interface MockToolDisplayItem {
  type: "tool"
  key: string
  toolPart: MockToolCallPart
  messageInfo?: unknown
  messageId: string
  messageVersion: number
  partVersion: number
}

// --- Helper factory ---

function makeToolDisplayItem(
  key: string,
  subagentType: string,
  description: string,
  status: MockToolState["status"],
  extra?: { output?: string; approachEvaluation?: unknown; summary?: unknown[] }
): MockToolDisplayItem {
  const metadata: Record<string, unknown> = {}
  if (extra?.output) metadata.output = extra.output
  if (extra?.approachEvaluation) metadata.approachEvaluation = extra.approachEvaluation
  if (extra?.summary) metadata.summary = extra.summary

  return {
    type: "tool",
    key,
    toolPart: {
      type: "tool",
      id: key,
      tool: "task",
      state: {
        status,
        input: JSON.stringify({ subagent_type: subagentType, description }),
        metadata,
      },
    },
    messageInfo: undefined,
    messageId: "msg-test-001",
    messageVersion: 1,
    partVersion: 0,
  }
}

// --- Pipeline tool sequences ---

/** Full implementation pipeline: coder → test-writer → reviewer (all completed) */
export const FULL_PIPELINE_COMPLETED: MockToolDisplayItem[] = [
  makeToolDisplayItem("t1", "coder", "Implement rate limiter", "completed", {
    summary: [
      { id: "s1", tool: "edit", status: "completed" },
      { id: "s2", tool: "write", status: "completed" },
    ],
  }),
  makeToolDisplayItem("t2", "test-writer", "Write rate limiter tests", "completed", {
    summary: [
      { id: "s3", tool: "write", status: "completed" },
      { id: "s4", tool: "bash", status: "completed" },
    ],
  }),
  makeToolDisplayItem("t3", "reviewer", "Review rate limiter code", "completed", {
    output: "## Code Review\n\nVERDICT: APPROVE\n\nAll checks passed.",
    summary: [
      { id: "s5", tool: "read", status: "completed" },
      { id: "s6", tool: "grep", status: "completed" },
    ],
  }),
]

/** Full pipeline with REJECT verdict */
export const FULL_PIPELINE_REJECTED: MockToolDisplayItem[] = [
  makeToolDisplayItem("t4", "coder", "Add user auth", "completed"),
  makeToolDisplayItem("t5", "test-writer", "Write auth tests", "completed"),
  makeToolDisplayItem("t6", "reviewer", "Review auth code", "completed", {
    output: "VERDICT: REJECT\n\nBLOCKER: Missing input validation on email field.",
  }),
]

/** Pipeline currently running (coder done, test-writer running, reviewer pending) */
export const PIPELINE_IN_PROGRESS: MockToolDisplayItem[] = [
  makeToolDisplayItem("t7", "coder", "Refactor database layer", "completed"),
  makeToolDisplayItem("t8", "test-writer", "Write database tests", "running"),
  makeToolDisplayItem("t9", "reviewer", "Review database code", "pending"),
]

/** Partial pipeline: coder → reviewer (no test-writer) */
export const CODE_REVIEW_PIPELINE: MockToolDisplayItem[] = [
  makeToolDisplayItem("t10", "coder", "Fix CSS layout bug", "completed"),
  makeToolDisplayItem("t11", "reviewer", "Review CSS fix", "completed", {
    output: "VERDICT: APPROVE\nClean fix.",
  }),
]

/** Partial pipeline: coder → test-writer (no reviewer) */
export const CODE_TEST_PIPELINE: MockToolDisplayItem[] = [
  makeToolDisplayItem("t12", "coder", "Add pagination", "completed"),
  makeToolDisplayItem("t13", "test-writer", "Write pagination tests", "completed"),
]

/** Pipeline with error in the middle */
export const PIPELINE_WITH_ERROR: MockToolDisplayItem[] = [
  makeToolDisplayItem("t14", "coder", "Implement caching", "completed"),
  makeToolDisplayItem("t15", "test-writer", "Write cache tests", "error"),
  makeToolDisplayItem("t16", "reviewer", "Review cache code", "pending"),
]

// --- Non-pipeline tool sequences ---

/** Single sub-agent (no pipeline) */
export const SINGLE_SUBAGENT: MockToolDisplayItem[] = [
  makeToolDisplayItem("t17", "explore", "Search for config files", "completed"),
]

/** Multiple sub-agents, no pipeline pattern */
export const UNRELATED_SUBAGENTS: MockToolDisplayItem[] = [
  makeToolDisplayItem("t18", "explore", "Find test files", "completed"),
  makeToolDisplayItem("t19", "researcher", "Research best practices", "completed"),
  makeToolDisplayItem("t20", "debugger", "Debug failing test", "running"),
]

/** Wrong order — reviewer before coder (not a pipeline) */
export const WRONG_ORDER_NOT_PIPELINE: MockToolDisplayItem[] = [
  makeToolDisplayItem("t21", "reviewer", "Review code", "completed"),
  makeToolDisplayItem("t22", "coder", "Implement feature", "completed"),
]

// --- Approach evaluation mock data ---

export const APPROACH_EVALUATION_DATA = {
  requirement: "Add rate limiting to the API",
  approaches: [
    {
      name: "Token Bucket Middleware",
      description: "Use express-rate-limit with in-memory token bucket algorithm",
      selected: true,
      complexity: "LOW",
      risk: "LOW",
      alignment: "HIGH",
      testability: "HIGH",
    },
    {
      name: "Redis-backed Distributed Limiter",
      description: "Use Redis sorted sets for distributed rate tracking across instances",
      selected: false,
      complexity: "MED",
      risk: "MED",
      alignment: "MED",
      testability: "MED",
    },
    {
      name: "Custom Sliding Window",
      description: "Implement a custom sliding window counter with configurable time windows",
      selected: false,
      complexity: "HIGH",
      risk: "LOW",
      alignment: "LOW",
      testability: "LOW",
    },
  ],
  rationale: "Token bucket aligns with existing Express middleware pattern and provides the simplest path.",
}

/** A task with approach evaluation metadata */
export const TASK_WITH_APPROACH: MockToolDisplayItem = makeToolDisplayItem(
  "t23",
  "coder",
  "Implement rate limiter",
  "completed",
  {
    approachEvaluation: APPROACH_EVALUATION_DATA,
    summary: [
      { id: "s7", tool: "skill", status: "completed", title: "Load approach-evaluation" },
      { id: "s8", tool: "edit", status: "completed", title: "Edit middleware.ts" },
      { id: "s9", tool: "write", status: "completed", title: "Write rate-limiter.ts" },
    ],
  }
)

/** A task without approach evaluation */
export const TASK_WITHOUT_APPROACH: MockToolDisplayItem = makeToolDisplayItem(
  "t24",
  "coder",
  "Fix typo in README",
  "completed",
  {
    summary: [{ id: "s10", tool: "edit", status: "completed", title: "Edit README.md" }],
  }
)

// --- Verdict edge cases ---

/** Reviewer with ambiguous output (no clear verdict) */
export const REVIEWER_AMBIGUOUS: MockToolDisplayItem = makeToolDisplayItem(
  "t25",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "The code looks mostly fine but has some issues that should be addressed." }
)

/** Reviewer with structured VERDICT: APPROVED */
export const REVIEWER_APPROVED_PAST_TENSE: MockToolDisplayItem = makeToolDisplayItem(
  "t26",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "## Code Review\n\nVERDICT: APPROVE\n\nNo blockers found." }
)

/** Reviewer with structured VERDICT: REJECT */
export const REVIEWER_REJECTED_PAST_TENSE: MockToolDisplayItem = makeToolDisplayItem(
  "t27",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "## Code Review\n\nVERDICT: REJECT\n\nBLOCKER: Missing error handling." }
)

/** Reviewer with no output (still running) */
export const REVIEWER_NO_OUTPUT: MockToolDisplayItem = makeToolDisplayItem(
  "t28",
  "reviewer",
  "Review auth code",
  "running"
)

// --- Tightened verdict edge cases (Issue 6) ---

/** Casual mention of "approve" — should NOT match as verdict */
export const REVIEWER_CASUAL_APPROVE: MockToolDisplayItem = makeToolDisplayItem(
  "t29",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "I approve of the general direction but have concerns about error handling." }
)

/** Casual mention of "reject" — should NOT match as verdict */
export const REVIEWER_CASUAL_REJECT: MockToolDisplayItem = makeToolDisplayItem(
  "t30",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "I wouldn't reject this outright, but it needs more tests." }
)

/** Line-start standalone APPROVE (Priority 2 match) */
export const REVIEWER_LINE_START_APPROVE: MockToolDisplayItem = makeToolDisplayItem(
  "t31",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "## Code Review\n\nAPPROVE\n\nAll checks passed." }
)

/** Line-start standalone REJECT with heading (Priority 2 match) */
export const REVIEWER_HEADING_REJECT: MockToolDisplayItem = makeToolDisplayItem(
  "t32",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "# REJECTED\n\nBLOCKER: SQL injection in login form." }
)

/** Bold markdown APPROVE (Priority 3 match) */
export const REVIEWER_BOLD_APPROVE: MockToolDisplayItem = makeToolDisplayItem(
  "t33",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "After careful review, the verdict is: **APPROVED**" }
)

/** Bold markdown REJECT (Priority 3 match) */
export const REVIEWER_BOLD_REJECT: MockToolDisplayItem = makeToolDisplayItem(
  "t34",
  "reviewer",
  "Review auth code",
  "completed",
  { output: "Code quality issues found. **REJECTED** pending fixes." }
)

// --- Interleaved pipeline sequence (Issue 7) ---

/** Pipeline with a regular tool interleaved between sub-agent tasks */
export const INTERLEAVED_PIPELINE: MockToolDisplayItem[] = [
  makeToolDisplayItem("t35", "coder", "Implement feature X", "completed"),
  // Gap: a non-task read tool would appear here in the real message stream
  makeToolDisplayItem("t36", "test-writer", "Write feature X tests", "completed"),
  makeToolDisplayItem("t37", "reviewer", "Review feature X code", "completed", {
    output: "VERDICT: APPROVE\nClean implementation.",
  }),
]

/** Factory function exposed for custom test fixtures */
export { makeToolDisplayItem }
