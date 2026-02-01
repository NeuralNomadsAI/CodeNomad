/**
 * Instruction Classifier
 *
 * Two-stage classification engine that detects instructional content in
 * user messages. Stage 1 uses regex pattern matching (fast, client-side).
 * Stage 2 optionally uses the active LLM session for borderline cases.
 *
 * Modeled after agent-intent.ts PatternRule structure.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstructionCategory =
  | "workflow"
  | "tooling"
  | "style"
  | "architecture"
  | "testing"
  | "quality"
  | "environment"
  | "communication"

export type InstructionScope = "project" | "global"

export interface ClassificationResult {
  isInstruction: boolean
  confidence: number
  category: InstructionCategory | null
  suggestedScope: InstructionScope
  extractedInstruction: string
  sourceMessage: string
  needsLlmConfirmation: boolean
}

export interface ClassifierConfig {
  enabled: boolean
  minConfidence: number
  llmConfirmationThreshold: number
  cooldownMs: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  enabled: true,
  minConfidence: 0.6,
  llmConfirmationThreshold: 0.8,
  cooldownMs: 30_000,
}

// ---------------------------------------------------------------------------
// Pattern Rules
// ---------------------------------------------------------------------------

interface InstructionPatternRule {
  patterns: RegExp[]
  category: InstructionCategory
  baseConfidence: number
  scopeHint: InstructionScope | null
}

const INSTRUCTION_RULES: InstructionPatternRule[] = [
  // --- workflow ---
  {
    category: "workflow",
    baseConfidence: 0.88,
    scopeHint: null,
    patterns: [
      /\balways create\b.+\b(milestone|issue|ticket|branch)/i,
      /\bcreate (a |an )?(linear|jira|github)\b/i,
      /\bfollow\b.+\bworkflow\b/i,
      /\bcommit\b.+\b(convention|message|format)/i,
      /\buse\b.+\b(branching|git\s?flow|trunk)/i,
    ],
  },
  // --- tooling ---
  {
    category: "tooling",
    baseConfidence: 0.85,
    scopeHint: "project",
    patterns: [
      /\buse\b.+\b(playwright|vitest|jest|mocha|cypress)\b/i,
      /\brun\b.+\bwith\b.+\b(flag|option|arg)/i,
      /\bprefer\b.+\b(pnpm|npm|yarn|bun)\b/i,
      /\buse\b.+\bfor\b.+\b(testing|building|linting|formatting)/i,
      /\brun\b.+\bon\s+a?\s*(free|random|available)\s+port/i,
    ],
  },
  // --- style ---
  {
    category: "style",
    baseConfidence: 0.82,
    scopeHint: "global",
    patterns: [
      /\bbe\b.+\b(critical|thorough|concise|verbose|detailed|brief)/i,
      /\bdon'?t\b.+\b(sugar\s?coat|flatter|praise)/i,
      /\bkeep\b.+\b(responses?|answers?|output)\b.+\b(short|concise|brief)/i,
      /\bexplain\b.+\b(simply|clearly|step by step)/i,
      /\buse\b.+\b(formal|informal|casual|professional)\b.+\btone/i,
    ],
  },
  // --- architecture ---
  {
    category: "architecture",
    baseConfidence: 0.85,
    scopeHint: "project",
    patterns: [
      /\bprefer\b.+\bover\b/i,
      /\bfollow\b.+\b(pattern|convention|principle)/i,
      /\buse\b.+\b(solid|dry|kiss|yagni)\b/i,
      /\b(composition|inheritance)\b.+\bover\b/i,
      /\barchitect\w*\b.+\bwith\b/i,
      /\bstructure\b.+\b(files?|folders?|modules?|packages?)\b.+\blike\b/i,
    ],
  },
  // --- testing ---
  {
    category: "testing",
    baseConfidence: 0.87,
    scopeHint: "project",
    patterns: [
      /\bwrite\b.+\b(tests?|specs?)\b.+\bfor\b/i,
      /\balways\b.+\btest/i,
      /\be2e\b.+\b(test|coverage|spec)/i,
      /\bunit test\b.+\bevery/i,
      /\bnever\b.+\bwithout\b.+\btest/i,
      /\btest\b.+\bbefore\b.+\b(commit|push|merge|deploy)/i,
    ],
  },
  // --- quality ---
  {
    category: "quality",
    baseConfidence: 0.83,
    scopeHint: "global",
    patterns: [
      /\bsuggest\b.+\bimprovements?\b/i,
      /\breview\b.+\b(thoroughly|carefully|critically)/i,
      /\bpoint out\b.+\b(issues?|problems?|flaws?)/i,
      /\bcheck\b.+\b(quality|standards?|best practices?)/i,
      /\bbe\b.+\b(hyper\s?critical|extra\s?critical|very\s?critical)/i,
      /\bflag\b.+\b(potential|possible)\b.+\b(issues?|bugs?|problems?)/i,
    ],
  },
  // --- environment ---
  {
    category: "environment",
    baseConfidence: 0.86,
    scopeHint: "project",
    patterns: [
      /\buse\b.+\bnode\b.+\b\d+/i,
      /\buse\b.+\b(python|ruby|java|go)\b.+\b[\d.]+/i,
      /\btarget\b.+\b(es\d+|esnext|node\s?\d+)/i,
      /\bset\b.+\b(env|environment)\b.+\bvariable/i,
      /\brequire\b.+\b(docker|container|kubernetes)/i,
      /\buse\b.+\b(nvm|volta|asdf|mise)\b/i,
    ],
  },
  // --- communication ---
  {
    category: "communication",
    baseConfidence: 0.80,
    scopeHint: "global",
    patterns: [
      /\bexplain\b.+\b(reasoning|thinking|rationale)\b.+\bbefore\b/i,
      /\bshow\b.+\b(your|the)\b.+\b(work|thought|reasoning)/i,
      /\bask\b.+\bbefore\b.+\b(proceeding|making|changing)/i,
      /\bconfirm\b.+\bbefore\b/i,
      /\blist\b.+\b(options|alternatives|choices)\b.+\bbefore\b/i,
    ],
  },
]

// --- Strong imperative patterns (category-agnostic, high confidence) ---
const STRONG_IMPERATIVE_PATTERNS: { pattern: RegExp; confidence: number }[] = [
  { pattern: /^always\b/i, confidence: 0.90 },
  { pattern: /^never\b/i, confidence: 0.90 },
  { pattern: /^from now on\b/i, confidence: 0.92 },
  { pattern: /^going forward\b/i, confidence: 0.88 },
  { pattern: /^in the future\b/i, confidence: 0.85 },
  { pattern: /^make sure\b.+\balways\b/i, confidence: 0.88 },
  { pattern: /^for (this|every|all) (project|repo)/i, confidence: 0.86 },
  { pattern: /^whenever\b.+\b(always|make sure|ensure)\b/i, confidence: 0.87 },
  { pattern: /^when (doing|working|writing|coding)\b.+\balways\b/i, confidence: 0.87 },
  { pattern: /^if\b.+\bthen\s+(always|never|make sure)\b/i, confidence: 0.85 },
  { pattern: /\bremember\s+to\b.+\balways\b/i, confidence: 0.84 },
]

// --- Negative patterns (exclude from classification) ---
const NEGATIVE_PATTERNS: RegExp[] = [
  // Questions
  /\bshould (I|we)\b/i,
  /\bcan (you|I|we)\b/i,
  /\bwhat (if|about|do)\b/i,
  /\bhow (do|should|can|would)\b/i,
  /\bis it\b.+\b(good|better|best|ok|okay)\b/i,
  /\bdo you (think|recommend|suggest)\b/i,
  /\?$/,

  // Past tense / narrative
  /\bI (used|tried|ran|did|had)\b/i,
  /\bwe (used|tried|ran|did|had)\b/i,
  /\byesterday\b/i,
  /\blast (time|week|month)\b/i,

  // Hypotheticals
  /\bwhat if\b/i,
  /\bwould it be\b/i,
  /\bcould we\b/i,
  /\bmight be\b/i,

  // Code blocks
  /^```/,
  /^\s{4,}\S/, // indented code

  // Short / trivial
  /^.{0,15}$/,
]

// ---------------------------------------------------------------------------
// Scope Detection
// ---------------------------------------------------------------------------

const PROJECT_SCOPE_PATTERNS: RegExp[] = [
  /\bthis (project|repo|repository|codebase)\b/i,
  /\bthis (folder|directory|package)\b/i,
  /\bfor this\b/i,
  /\bhere\b/i,
  /\bin (this|the) (repo|project|workspace)\b/i,
  // File / path references
  /\b(src|lib|packages?|components?|modules?)\//i,
  /\.\w{2,4}$/i, // file extension
]

const GLOBAL_SCOPE_PATTERNS: RegExp[] = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bevery (project|repo|time)\b/i,
  /\ball (projects?|repos?|repositories)\b/i,
  /\bin general\b/i,
  /\bacross\b.+\b(projects?|repos?)\b/i,
  /\bgoing forward\b/i,
  /\bfrom now on\b/i,
]

function detectScope(message: string): InstructionScope {
  let projectScore = 0
  let globalScore = 0

  for (const p of PROJECT_SCOPE_PATTERNS) {
    if (p.test(message)) projectScore++
  }
  for (const p of GLOBAL_SCOPE_PATTERNS) {
    if (p.test(message)) globalScore++
  }

  // When "always" / "never" appear alongside project references, project wins
  if (projectScore > 0 && globalScore > 0) {
    return projectScore >= globalScore ? "project" : "global"
  }

  if (globalScore > projectScore) return "global"

  // Default: project (safer — user can promote)
  return "project"
}

// ---------------------------------------------------------------------------
// Text Extraction Helpers
// ---------------------------------------------------------------------------

/**
 * Strip code blocks and inline code from a message before classification.
 */
function stripCode(message: string): string {
  return message
    .replace(/```[\s\S]*?```/g, "") // fenced code blocks
    .replace(/`[^`]+`/g, "")        // inline code
    .trim()
}

/**
 * Extract a clean instruction from the matched message.
 * Removes conversational filler while preserving the directive.
 */
function extractInstruction(message: string): string {
  let text = stripCode(message).trim()

  // Remove leading filler phrases
  text = text
    .replace(/^(please|hey|also|oh|btw|by the way|fyi|note)[,:]?\s*/i, "")
    .replace(/^(I want you to|I'd like you to|you should|make sure to)\s*/i, "")
    .trim()

  // Truncate to first sentence / first ~200 chars if very long
  if (text.length > 200) {
    const firstPeriod = text.indexOf(".", 40)
    if (firstPeriod > 0 && firstPeriod < 200) {
      text = text.slice(0, firstPeriod + 1)
    } else {
      text = text.slice(0, 200).replace(/\s+\S*$/, "...")
    }
  }

  return text
}

// ---------------------------------------------------------------------------
// Category Boosters & Dampeners
// ---------------------------------------------------------------------------

interface BoosterRule {
  keywords: RegExp[]
  category: InstructionCategory
  boost: number // added to confidence
}

const BOOSTERS: BoosterRule[] = [
  {
    category: "testing",
    boost: 0.05,
    keywords: [/\bplaywright\b/i, /\bvitest\b/i, /\bjest\b/i, /\bcypress\b/i],
  },
  {
    category: "tooling",
    boost: 0.04,
    keywords: [/\bport\b/i, /\bflag\b/i, /\bconfig\b/i, /\bcli\b/i],
  },
  {
    category: "environment",
    boost: 0.04,
    keywords: [/\bdocker\b/i, /\bnode\b/i, /\bpython\b/i],
  },
]

const DAMPENERS: { category: InstructionCategory; pattern: RegExp; dampen: number }[] = [
  // Generic "use X" without specific tool context
  { category: "tooling", pattern: /^use \w+$/i, dampen: -0.15 },
  // Very short messages
  { category: "style", pattern: /^.{0,25}$/i, dampen: -0.10 },
]

// ---------------------------------------------------------------------------
// Stage 1: Regex Pre-Filter
// ---------------------------------------------------------------------------

export function regexPreFilter(message: string): ClassificationResult {
  const cleaned = stripCode(message)
  const sourceMessage = message

  // Build a negative result template
  const negative: ClassificationResult = {
    isInstruction: false,
    confidence: 0,
    category: null,
    suggestedScope: "project",
    extractedInstruction: "",
    sourceMessage,
    needsLlmConfirmation: false,
  }

  // Check negative patterns first
  for (const np of NEGATIVE_PATTERNS) {
    if (np.test(cleaned)) {
      return negative
    }
  }

  // Score each category
  const categoryScores = new Map<InstructionCategory, number>()

  // Check category-specific rules
  for (const rule of INSTRUCTION_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(cleaned)) {
        const current = categoryScores.get(rule.category) ?? 0
        categoryScores.set(rule.category, Math.max(current, rule.baseConfidence))
      }
    }
  }

  // Check strong imperative patterns (boost best category or set generic)
  let imperativeBoost = 0
  for (const { pattern, confidence } of STRONG_IMPERATIVE_PATTERNS) {
    if (pattern.test(cleaned)) {
      imperativeBoost = Math.max(imperativeBoost, confidence)
    }
  }

  // If imperative matched but no category, try to infer one or leave null
  if (imperativeBoost > 0 && categoryScores.size === 0) {
    // Generic instruction detected — assign highest imperative confidence
    // Category will be null — the LLM stage can refine it
    const scope = detectScope(cleaned)
    const extracted = extractInstruction(message)
    return {
      isInstruction: true,
      confidence: imperativeBoost * 0.9, // slight discount for no category
      category: null,
      suggestedScope: scope,
      extractedInstruction: extracted,
      sourceMessage,
      needsLlmConfirmation: true, // no category → needs LLM refinement
    }
  }

  if (categoryScores.size === 0) {
    return negative
  }

  // Find best category
  let bestCategory: InstructionCategory | null = null
  let bestScore = 0
  for (const [cat, score] of categoryScores) {
    if (score > bestScore) {
      bestScore = score
      bestCategory = cat
    }
  }

  if (!bestCategory) return negative

  // Apply boosters
  for (const b of BOOSTERS) {
    if (b.category === bestCategory) {
      for (const kw of b.keywords) {
        if (kw.test(cleaned)) {
          bestScore = Math.min(bestScore + b.boost, 0.98)
          break
        }
      }
    }
  }

  // Apply dampeners
  for (const d of DAMPENERS) {
    if (d.category === bestCategory && d.pattern.test(cleaned)) {
      bestScore = Math.max(bestScore + d.dampen, 0.1)
    }
  }

  // If imperative also matched, boost overall
  if (imperativeBoost > 0) {
    bestScore = Math.min(bestScore + 0.05, 0.98)
  }

  // Determine scope (use rule's hint or detect)
  const ruleHint = INSTRUCTION_RULES.find((r) => r.category === bestCategory)?.scopeHint
  const scope = ruleHint ?? detectScope(cleaned)

  const extracted = extractInstruction(message)

  return {
    isInstruction: bestScore >= DEFAULT_CLASSIFIER_CONFIG.minConfidence,
    confidence: Math.round(bestScore * 100) / 100,
    category: bestCategory,
    suggestedScope: scope,
    extractedInstruction: extracted,
    sourceMessage,
    needsLlmConfirmation: bestScore < DEFAULT_CLASSIFIER_CONFIG.llmConfirmationThreshold,
  }
}

// ---------------------------------------------------------------------------
// Stage 2: LLM Confirmation (server-side via /api/era/classify-confirm)
// ---------------------------------------------------------------------------

export interface LlmClassifyResponse {
  isInstruction: boolean
  category: string | null
  instruction: string
  scope: "project" | "global"
  confidence: number
}

export interface LlmUnavailableResponse {
  unavailable: true
}

export type ClassifyConfirmResponse = LlmClassifyResponse | LlmUnavailableResponse

/**
 * Check whether the server response indicates the LLM is unavailable.
 */
export function isLlmUnavailable(resp: ClassifyConfirmResponse): resp is LlmUnavailableResponse {
  return "unavailable" in resp && resp.unavailable === true
}

/**
 * Merge a server-side LLM classification result into an existing regex
 * ClassificationResult, producing a refined result with updated
 * confidence, category, and instruction text.
 */
export function mergeWithLlmResult(
  regexResult: ClassificationResult,
  llmResult: LlmClassifyResponse,
): ClassificationResult {
  if (!llmResult.isInstruction) {
    // LLM says it's not an instruction — suppress
    return {
      ...regexResult,
      isInstruction: false,
      confidence: Math.max(regexResult.confidence - 0.3, 0),
      needsLlmConfirmation: false,
    }
  }

  return {
    ...regexResult,
    isInstruction: true,
    confidence: Math.min(
      Math.max(regexResult.confidence, llmResult.confidence, 0.85),
      0.98,
    ),
    category: (llmResult.category as InstructionCategory) ?? regexResult.category,
    suggestedScope: llmResult.scope ?? regexResult.suggestedScope,
    extractedInstruction: llmResult.instruction || regexResult.extractedInstruction,
    needsLlmConfirmation: false,
  }
}

// ---------------------------------------------------------------------------
// Cooldown & Debounce
// ---------------------------------------------------------------------------

let lastCardShownAt = 0

/**
 * Check whether the cooldown has elapsed since the last capture card.
 */
export function isCooldownActive(config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG): boolean {
  return Date.now() - lastCardShownAt < config.cooldownMs
}

/**
 * Record that a capture card was shown (resets the cooldown timer).
 */
export function recordCardShown(): void {
  lastCardShownAt = Date.now()
}

/**
 * Reset cooldown state (useful for testing).
 */
export function resetCooldown(): void {
  lastCardShownAt = 0
}

// ---------------------------------------------------------------------------
// Top-Level Classify
// ---------------------------------------------------------------------------

/**
 * Full classification pipeline: regex pre-filter → cooldown check → result.
 * The LLM confirmation stage is intentionally left to the caller because
 * it requires an active session handle which this module doesn't own.
 */
export function classify(
  message: string,
  config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG,
): ClassificationResult | null {
  if (!config.enabled) return null
  if (isCooldownActive(config)) return null

  const result = regexPreFilter(message)

  if (!result.isInstruction) return null
  if (result.confidence < config.minConfidence) return null

  return result
}
