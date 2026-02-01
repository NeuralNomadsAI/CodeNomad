/**
 * LLM Classifier Service
 *
 * Uses Anthropic's Haiku model to refine borderline instruction classifications
 * from the client-side regex pre-filter. Best-effort: returns null on any failure.
 *
 * Follows the era-memory-client.ts pattern for fetch/timeout/error handling.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmClassificationResult {
  isInstruction: boolean
  category: string | null
  instruction: string
  scope: "project" | "global"
  confidence: number
}

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

class LruCache<V> {
  private map = new Map<string, V>()
  constructor(private maxSize: number) {}

  get(key: string): V | undefined {
    const val = this.map.get(key)
    if (val !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key)
      this.map.set(key, val)
    }
    return val
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      // Delete oldest (first) entry
      const firstKey = this.map.keys().next().value
      if (firstKey !== undefined) this.map.delete(firstKey)
    }
    this.map.set(key, value)
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const MODEL = "claude-haiku-4-20250414"
const MAX_TOKENS = 100
const TIMEOUT_MS = 3_000

const SYSTEM_PROMPT = `You classify user messages as standing instructions (preferences the user wants remembered across sessions) or regular messages.

Respond ONLY with JSON: {"isInstruction":boolean,"category":string|null,"instruction":string,"scope":"project"|"global","confidence":number}

Categories: workflow, tooling, style, architecture, testing, quality, environment, communication
- "instruction": cleaned directive text (imperative form, no filler)
- "scope": "project" if references this repo/project, "global" if universal preference
- "confidence": 0.0-1.0 how certain this is a standing instruction
- If not an instruction, set isInstruction=false, category=null, confidence below 0.5`

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export class LlmClassifier {
  private apiKey: string | undefined
  private cache = new LruCache<LlmClassificationResult>(50)

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY
  }

  /**
   * Returns true if the classifier can make API calls.
   */
  isAvailable(): boolean {
    return !!this.apiKey
  }

  /**
   * Classify a message using Haiku. Returns null on any failure.
   */
  async classify(message: string): Promise<LlmClassificationResult | null> {
    if (!this.apiKey) return null

    // Check cache first (normalize by trimming and lowercasing)
    const cacheKey = message.trim().toLowerCase()
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const resp = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Classify this message: "${message}"`,
            },
          ],
        }),
        signal: controller.signal,
      })

      if (!resp.ok) return null

      const data = (await resp.json()) as {
        content?: Array<{ type: string; text?: string }>
      }

      const textBlock = data.content?.find((b) => b.type === "text")
      if (!textBlock?.text) return null

      const parsed = JSON.parse(textBlock.text) as LlmClassificationResult

      // Basic validation
      if (typeof parsed.isInstruction !== "boolean") return null
      if (typeof parsed.confidence !== "number") return null

      const result: LlmClassificationResult = {
        isInstruction: parsed.isInstruction,
        category: parsed.category ?? null,
        instruction: parsed.instruction ?? message,
        scope: parsed.scope === "global" ? "global" : "project",
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
      }

      this.cache.set(cacheKey, result)
      return result
    } catch {
      // Timeout, network error, JSON parse error — all return null
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
}
