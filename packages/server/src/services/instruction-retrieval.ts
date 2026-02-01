/**
 * Instruction Retrieval Service
 *
 * Proactively retrieves relevant instructions from Era Memory at session
 * start and during tool invocation, deduplicates against active directives,
 * and tracks access counts for retrieval optimization.
 */
import { EraMemoryClient, type MemorySearchResult, type Memory } from "./era-memory-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievedInstruction {
  id: string
  content: string
  category: string | null
  scope: string
  score: number
  accessCount: number
  createdAt?: string
}

export interface RetrievalContext {
  projectName?: string
  language?: string
  activeTools?: string[]
  activeDirectives?: string[]
}

// ---------------------------------------------------------------------------
// Tool → Category Mapping
// ---------------------------------------------------------------------------

const TOOL_CATEGORY_MAP: Record<string, string[]> = {
  playwright: ["testing"],
  vitest: ["testing"],
  jest: ["testing"],
  cypress: ["testing"],
  git: ["workflow"],
  github: ["workflow"],
  build: ["environment"],
  docker: ["environment"],
  npm: ["environment", "tooling"],
  pnpm: ["environment", "tooling"],
  yarn: ["environment", "tooling"],
  eslint: ["quality", "style"],
  prettier: ["style"],
}

// ---------------------------------------------------------------------------
// Session Cache
// ---------------------------------------------------------------------------

interface SessionCache {
  sessionStartInstructions: RetrievedInstruction[]
  queriedTools: Set<string>
  accessLog: Map<string, number>
}

const sessionCaches = new Map<string, SessionCache>()

function getSessionCache(sessionId: string): SessionCache {
  let cache = sessionCaches.get(sessionId)
  if (!cache) {
    cache = {
      sessionStartInstructions: [],
      queriedTools: new Set(),
      accessLog: new Map(),
    }
    sessionCaches.set(sessionId, cache)
  }
  return cache
}

export function clearSessionCache(sessionId: string): void {
  sessionCaches.delete(sessionId)
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function isDuplicateOfDirective(instruction: string, directives: string[]): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)

  const instructionTokens = new Set(normalize(instruction))

  for (const dir of directives) {
    const dirTokens = new Set(normalize(dir))
    if (dirTokens.size === 0 || instructionTokens.size === 0) continue
    let intersection = 0
    for (const t of instructionTokens) {
      if (dirTokens.has(t)) intersection++
    }
    const similarity = intersection / (instructionTokens.size + dirTokens.size - intersection)
    if (similarity > 0.75) return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export class InstructionRetrieval {
  private memoryClient: EraMemoryClient

  constructor(memoryClient?: EraMemoryClient) {
    this.memoryClient = memoryClient ?? new EraMemoryClient()
  }

  /**
   * Retrieve instructions at session start.
   * Results are cached for the session's lifetime.
   */
  async retrieveAtSessionStart(
    sessionId: string,
    context: RetrievalContext,
  ): Promise<RetrievedInstruction[]> {
    const cache = getSessionCache(sessionId)

    // Return cached results if already queried
    if (cache.sessionStartInstructions.length > 0) {
      return cache.sessionStartInstructions
    }

    try {
      const available = await this.memoryClient.isAvailable()
      if (!available) return []

      const query = buildSessionQuery(context)
      const results = await this.memoryClient.search({
        query,
        type: "preference",
        limit: 10,
        minScore: 0.7,
      })

      const instructions = results
        .map((r) => toRetrievedInstruction(r))
        .filter((inst) => {
          // Deduplicate against active directives
          if (context.activeDirectives && isDuplicateOfDirective(inst.content, context.activeDirectives)) {
            return false
          }
          return true
        })
        .slice(0, 5) // Max 5 per session start

      cache.sessionStartInstructions = instructions

      // Track access
      for (const inst of instructions) {
        this.trackAccess(sessionId, inst.id)
      }

      return instructions
    } catch {
      return []
    }
  }

  /**
   * Retrieve tool-specific instructions when a tool is invoked.
   * Each tool is only queried once per session (cooldown).
   */
  async retrieveForTool(
    sessionId: string,
    toolName: string,
    context: RetrievalContext,
  ): Promise<RetrievedInstruction[]> {
    const cache = getSessionCache(sessionId)

    // Per-tool cooldown
    const normalizedTool = toolName.toLowerCase()
    if (cache.queriedTools.has(normalizedTool)) {
      return []
    }
    cache.queriedTools.add(normalizedTool)

    try {
      const available = await this.memoryClient.isAvailable()
      if (!available) return []

      const categories = TOOL_CATEGORY_MAP[normalizedTool] ?? []
      const query = [toolName, ...categories, context.projectName].filter(Boolean).join(" ")

      const results = await this.memoryClient.search({
        query,
        type: "preference",
        limit: 5,
        minScore: 0.7,
      })

      const instructions = results
        .map((r) => toRetrievedInstruction(r))
        .filter((inst) => {
          if (context.activeDirectives && isDuplicateOfDirective(inst.content, context.activeDirectives)) {
            return false
          }
          return true
        })
        .slice(0, 3)

      for (const inst of instructions) {
        this.trackAccess(sessionId, inst.id)
      }

      return instructions
    } catch {
      return []
    }
  }

  /**
   * Track that an instruction was accessed.
   */
  private trackAccess(sessionId: string, instructionId: string): void {
    const cache = getSessionCache(sessionId)
    const current = cache.accessLog.get(instructionId) ?? 0
    cache.accessLog.set(instructionId, current + 1)
  }

  /**
   * Flush access counts to Era Memory at session end.
   */
  async flushAccessCounts(sessionId: string): Promise<void> {
    const cache = sessionCaches.get(sessionId)
    if (!cache) return

    try {
      const available = await this.memoryClient.isAvailable()
      if (!available) return

      for (const [id, count] of cache.accessLog) {
        try {
          await this.memoryClient.update(id, {
            metadata: { lastAccessed: new Date().toISOString(), accessCount: count },
          })
        } catch {
          // Best-effort — don't fail the session for access tracking
        }
      }
    } finally {
      clearSessionCache(sessionId)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSessionQuery(context: RetrievalContext): string {
  const parts: string[] = []
  if (context.projectName) parts.push(context.projectName)
  if (context.language) parts.push(context.language)
  if (context.activeTools) parts.push(...context.activeTools.slice(0, 3))
  return parts.join(" ") || "development preferences"
}

function toRetrievedInstruction(result: MemorySearchResult): RetrievedInstruction {
  const meta = (result.memory.metadata ?? {}) as Record<string, unknown>
  return {
    id: result.memory.id,
    content: result.memory.content,
    category: (meta.category as string) ?? null,
    scope: (meta.scope as string) ?? "global",
    score: result.score,
    accessCount: (meta.accessCount as number) ?? 0,
    createdAt: result.memory.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

export interface PruneResult {
  flaggedForReview: string[]
  archived: string[]
  errors: string[]
}

const STALE_THRESHOLD_DAYS = 90
const ZERO_ACCESS_ARCHIVE_DAYS = 30
const MAX_MEMORIES_PER_PROJECT = 50
const MAX_MEMORIES_GLOBAL = 100

export class InstructionPruner {
  private memoryClient: EraMemoryClient

  constructor(memoryClient?: EraMemoryClient) {
    this.memoryClient = memoryClient ?? new EraMemoryClient()
  }

  /**
   * Run the pruning engine. Flags stale instructions, auto-archives
   * zero-access ones, and enforces per-project/global limits.
   */
  async prune(projectPath?: string): Promise<PruneResult> {
    const result: PruneResult = {
      flaggedForReview: [],
      archived: [],
      errors: [],
    }

    try {
      const available = await this.memoryClient.isAvailable()
      if (!available) return result

      // Search for all preference memories
      const allMemories = await this.memoryClient.search({
        query: "development preferences instructions guidance",
        type: "preference",
        limit: 250,
        minScore: 0.0,
      })

      const now = Date.now()

      // Separate project vs global memories
      const projectMemories: typeof allMemories = []
      const globalMemories: typeof allMemories = []

      for (const m of allMemories) {
        const meta = (m.memory.metadata ?? {}) as Record<string, unknown>
        const memProject = meta.projectPath as string | undefined

        if (memProject && memProject === projectPath) {
          projectMemories.push(m)
        } else if (!memProject) {
          globalMemories.push(m)
        }
      }

      // --- Flag stale (90d no access) ---
      for (const m of allMemories) {
        const meta = (m.memory.metadata ?? {}) as Record<string, unknown>
        const lastAccessed = meta.lastAccessed as string | undefined
        const accessCount = (meta.accessCount as number) ?? 0
        const createdAt = m.memory.createdAt

        const referenceDate = lastAccessed ?? createdAt
        if (!referenceDate) continue

        const ageMs = now - new Date(referenceDate).getTime()
        const ageDays = ageMs / (1000 * 60 * 60 * 24)

        if (ageDays > STALE_THRESHOLD_DAYS) {
          result.flaggedForReview.push(m.memory.id)

          try {
            await this.memoryClient.update(m.memory.id, {
              metadata: { ...meta, pruneStatus: "flagged_stale", flaggedAt: new Date().toISOString() },
            })
          } catch {
            result.errors.push(`Failed to flag ${m.memory.id}`)
          }
        }

        // --- Auto-archive (30d, 0 access) ---
        if (accessCount === 0 && ageDays > ZERO_ACCESS_ARCHIVE_DAYS) {
          result.archived.push(m.memory.id)

          try {
            await this.memoryClient.update(m.memory.id, {
              metadata: { ...meta, pruneStatus: "archived", archivedAt: new Date().toISOString() },
            })
          } catch {
            result.errors.push(`Failed to archive ${m.memory.id}`)
          }
        }
      }

      // --- Enforce per-project limit ---
      if (projectMemories.length > MAX_MEMORIES_PER_PROJECT) {
        // Sort by access count (lowest first), then by age (oldest first)
        const sorted = [...projectMemories].sort((a, b) => {
          const metaA = (a.memory.metadata ?? {}) as Record<string, unknown>
          const metaB = (b.memory.metadata ?? {}) as Record<string, unknown>
          const accessA = (metaA.accessCount as number) ?? 0
          const accessB = (metaB.accessCount as number) ?? 0
          if (accessA !== accessB) return accessA - accessB
          const dateA = a.memory.createdAt ? new Date(a.memory.createdAt).getTime() : 0
          const dateB = b.memory.createdAt ? new Date(b.memory.createdAt).getTime() : 0
          return dateA - dateB
        })

        const toArchive = sorted.slice(0, sorted.length - MAX_MEMORIES_PER_PROJECT)
        for (const m of toArchive) {
          if (!result.archived.includes(m.memory.id)) {
            result.archived.push(m.memory.id)
            try {
              const meta = (m.memory.metadata ?? {}) as Record<string, unknown>
              await this.memoryClient.update(m.memory.id, {
                metadata: { ...meta, pruneStatus: "archived_limit", archivedAt: new Date().toISOString() },
              })
            } catch {
              result.errors.push(`Failed to archive (limit) ${m.memory.id}`)
            }
          }
        }
      }

      // --- Enforce global limit ---
      if (globalMemories.length > MAX_MEMORIES_GLOBAL) {
        const sorted = [...globalMemories].sort((a, b) => {
          const metaA = (a.memory.metadata ?? {}) as Record<string, unknown>
          const metaB = (b.memory.metadata ?? {}) as Record<string, unknown>
          const accessA = (metaA.accessCount as number) ?? 0
          const accessB = (metaB.accessCount as number) ?? 0
          if (accessA !== accessB) return accessA - accessB
          const dateA = a.memory.createdAt ? new Date(a.memory.createdAt).getTime() : 0
          const dateB = b.memory.createdAt ? new Date(b.memory.createdAt).getTime() : 0
          return dateA - dateB
        })

        const toArchive = sorted.slice(0, sorted.length - MAX_MEMORIES_GLOBAL)
        for (const m of toArchive) {
          if (!result.archived.includes(m.memory.id)) {
            result.archived.push(m.memory.id)
            try {
              const meta = (m.memory.metadata ?? {}) as Record<string, unknown>
              await this.memoryClient.update(m.memory.id, {
                metadata: { ...meta, pruneStatus: "archived_limit", archivedAt: new Date().toISOString() },
              })
            } catch {
              result.errors.push(`Failed to archive (limit) ${m.memory.id}`)
            }
          }
        }
      }
    } catch (err) {
      result.errors.push(`Pruning failed: ${err instanceof Error ? err.message : "unknown"}`)
    }

    return result
  }
}

// ---------------------------------------------------------------------------
// Feedback Loop
// ---------------------------------------------------------------------------

export interface FeedbackEvent {
  sessionId: string
  instructionId: string
  outcome: "success" | "failure" | "dismissed"
}

const PROMOTION_THRESHOLD = 10

export async function recordFeedback(
  memoryClient: EraMemoryClient,
  event: FeedbackEvent,
): Promise<{ promoted: boolean }> {
  try {
    const available = await memoryClient.isAvailable()
    if (!available) return { promoted: false }

    // Search for the memory to get current metadata
    const results = await memoryClient.search({
      query: event.instructionId,
      type: "preference",
      limit: 1,
      minScore: 0.0,
    })

    if (results.length === 0) return { promoted: false }

    const memory = results[0].memory
    const meta = (memory.metadata ?? {}) as Record<string, unknown>

    let score = (meta.feedbackScore as number) ?? 0
    let accessCount = (meta.accessCount as number) ?? 0

    switch (event.outcome) {
      case "success":
        score += 1
        accessCount += 1
        break
      case "failure":
        score -= 0.5
        break
      case "dismissed":
        score -= 0.25
        break
    }

    await memoryClient.update(memory.id, {
      metadata: {
        ...meta,
        feedbackScore: score,
        accessCount,
        lastFeedback: event.outcome,
        lastFeedbackAt: new Date().toISOString(),
      },
    })

    // Check if it should be promoted to a directive
    const promoted = score >= PROMOTION_THRESHOLD && accessCount >= PROMOTION_THRESHOLD
    return { promoted }
  } catch {
    return { promoted: false }
  }
}

// ---------------------------------------------------------------------------
// Prompt Composition
// ---------------------------------------------------------------------------

/**
 * Format retrieved instructions for injection into the system prompt.
 * Returns empty string if no instructions to inject.
 */
export function composeRetrievedSection(instructions: RetrievedInstruction[]): string {
  if (instructions.length === 0) return ""

  const lines = instructions.map((inst) => {
    const date = inst.createdAt ? ` (saved ${inst.createdAt.split("T")[0]})` : ""
    return `- ${inst.content}${date}`
  })

  return `## Retrieved Preferences\n${lines.join("\n")}\n`
}
