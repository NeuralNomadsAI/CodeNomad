/**
 * Classify prompt intent to suggest an agent for auto-routing.
 * Pure heuristic — no API calls, zero latency.
 * Returns the agent name or null if no match / agent unavailable.
 */

type PatternRule = {
  patterns: RegExp[]
  agent: string
}

const RULES: PatternRule[] = [
  {
    agent: "plan",
    patterns: [
      /\bplan\b/i,
      /\bdesign\b/i,
      /\barchitect\b/i,
      /\bdocument\b/i,
      /\boutline\b/i,
      /\bspec\b/i,
      /\brfc\b/i,
      /\bproposal\b/i,
    ],
  },
  {
    agent: "explore",
    patterns: [
      /\bfind\b/i,
      /\bwhere is\b/i,
      /\bsearch\b/i,
      /\bexplore\b/i,
      /\bhow does\b/i,
      /\bwhat is\b/i,
      /\bwhich file\b/i,
      /\blook for\b/i,
      /\blocate\b/i,
    ],
  },
  {
    agent: "reviewer",
    patterns: [
      /\breview\b/i,
      /\baudit\b/i,
      /\bcheck quality\b/i,
      /\bcode review\b/i,
    ],
  },
  {
    agent: "test-writer",
    patterns: [
      /\bwrite test/i,
      /\badd test/i,
      /\btest for\b/i,
      /\bspec for\b/i,
      /\bunit test/i,
      /\be2e test/i,
    ],
  },
  {
    agent: "debugger",
    patterns: [
      /\bdebug\b/i,
      /\bwhy is\b/i,
      /\bwhy does\b/i,
      /\bnot working\b/i,
      /\bbroken\b/i,
      /\berror\b/i,
      /\bcrash\b/i,
      /\bstack trace\b/i,
    ],
  },
  {
    agent: "researcher",
    patterns: [
      /\bresearch\b/i,
      /\blook up\b/i,
      /\bwhat are the options\b/i,
      /\bcompare\b/i,
    ],
  },
]

export function classifyPromptIntent(
  prompt: string,
  availableAgents: string[],
): string | null {
  const trimmed = prompt.trimStart()

  // Slash commands — don't reroute
  if (trimmed.startsWith("/")) {
    return null
  }

  // Only scan first ~200 characters for intent signals
  const snippet = trimmed.slice(0, 200)

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(snippet)) {
        return availableAgents.includes(rule.agent) ? rule.agent : null
      }
    }
  }

  return null
}

/**
 * Agents that cannot execute commands (read-only / advisory).
 * When the user's follow-up prompt signals execution intent,
 * we auto-escalate out of these agents.
 */
const READ_ONLY_AGENTS = new Set(["plan", "explore", "reviewer", "researcher"])

/** Patterns that signal "stop planning, start doing". */
const EXECUTION_PATTERNS: RegExp[] = [
  /\bimplement\b/i,
  /\bdo it\b/i,
  /\bgo ahead\b/i,
  /\bbuild\b/i,
  /\bcreate\b/i,
  /\bwrite\b/i,
  /\bcode\b/i,
  /\bapply\b/i,
  /\bexecute\b/i,
  /\brun\b/i,
  /\bmake (it|the|this|that)\b/i,
  /\bship it\b/i,
  /\blet'?s go\b/i,
  /\bproceed\b/i,
  /\bstart\b/i,
  /\bnow (fix|add|update|change|refactor|remove|delete)\b/i,
  /\b(ok|okay|yes|yep|sure|please|sounds good|lgtm)\b.*\b(implement|build|do|make|proceed|go)\b/i,
  /^(ok|okay|yes|yep|sure|go|do it|proceed|ship it|lgtm|sounds good|please)[\s!.]*$/i,
]

/**
 * Check whether a follow-up prompt should auto-escalate OUT of a
 * read-only agent (like "plan") into an execution-capable agent.
 *
 * Returns the target agent name, or null if no escalation needed.
 */
export function shouldEscalateAgent(
  prompt: string,
  currentAgent: string,
  availableAgents: string[],
): string | null {
  if (!READ_ONLY_AGENTS.has(currentAgent)) return null

  const trimmed = prompt.trimStart()
  if (trimmed.startsWith("/")) return null

  const snippet = trimmed.slice(0, 300)

  const hasExecutionIntent = EXECUTION_PATTERNS.some((p) => p.test(snippet))
  if (!hasExecutionIntent) return null

  // Try to pick the best execution agent, in order of preference
  const candidates = ["coder", "main", "debugger", "test-writer"]
  for (const candidate of candidates) {
    if (availableAgents.includes(candidate)) return candidate
  }

  // Fallback: pick any agent that isn't read-only
  for (const name of availableAgents) {
    if (!READ_ONLY_AGENTS.has(name)) return name
  }

  return null
}
