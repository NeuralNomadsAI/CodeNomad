/**
 * Governance Writer Service
 *
 * Routes accepted instructions to the correct storage layer:
 * - Directives file (.era/memory/directives.md)
 * - Era Memory API (semantic recall)
 * - Both (for categories that benefit from enforcement + recall)
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { EraMemoryClient, type MemorySearchResult } from "./era-memory-client"

// ---------------------------------------------------------------------------
// Types (shared with the UI)
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

export interface WriteInstructionRequest {
  instruction: string
  category: InstructionCategory
  scope: InstructionScope
  storageOverride?: "directive" | "memory" | null
  projectPath?: string
}

export interface WriteInstructionResponse {
  stored: boolean
  storageType: "directive" | "memory" | "both"
  directiveId?: string
  memoryId?: string
  deduplicated: boolean
  warning?: string
  conflicts?: ConflictInfo[]
}

export interface ConflictInfo {
  type: "semantic_opposition" | "scope_conflict" | "category_overlap"
  existingInstruction: string
  similarity: number
  recommendation: string
}

export interface SavedInstruction {
  id: string
  content: string
  category: InstructionCategory
  scope: InstructionScope
  storageType: "directive" | "memory"
  createdAt?: string
  accessCount?: number
  projectPath?: string
}

export interface DeleteInstructionRequest {
  id: string
  storageType: "directive" | "memory"
  category?: InstructionCategory
  projectPath?: string
}

export interface EditInstructionRequest {
  id: string
  storageType: "directive" | "memory"
  newContent: string
  category?: InstructionCategory
  projectPath?: string
}

export interface PromoteRequest {
  id: string
  content: string
  category: InstructionCategory
  scope: InstructionScope
  projectPath?: string
}

export interface ListInstructionsRequest {
  scope?: InstructionScope
  projectPath?: string
}

// ---------------------------------------------------------------------------
// Category → Storage routing
// ---------------------------------------------------------------------------

type StorageTarget = "directive" | "memory" | "both"

const CATEGORY_STORAGE: Record<InstructionCategory, StorageTarget> = {
  workflow: "directive",
  tooling: "directive",
  architecture: "directive",
  environment: "directive",
  style: "memory",
  communication: "memory",
  testing: "both",
  quality: "both",
}

// Category → Directive section heading
const CATEGORY_SECTION: Record<InstructionCategory, string> = {
  workflow: "Workflow",
  tooling: "Tooling",
  architecture: "Architecture",
  environment: "Environment",
  testing: "Testing",
  quality: "Quality",
  style: "Style",
  communication: "Communication",
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

/**
 * Simple normalized text similarity (Jaccard on tokens).
 */
function textSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
  const tokensA = new Set(normalize(a))
  const tokensB = new Set(normalize(b))
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let intersection = 0
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++
  }
  return intersection / (tokensA.size + tokensB.size - intersection)
}

// ---------------------------------------------------------------------------
// Directive file operations
// ---------------------------------------------------------------------------

function getDirectivesPath(projectPath?: string): string {
  if (projectPath) {
    return path.join(projectPath, ".era", "memory", "directives.md")
  }
  // Global directives (home dir)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  return path.join(home, ".era", "memory", "directives.md")
}

function readDirectivesFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8")
  } catch {
    return ""
  }
}

function ensureDirectoryExists(filePath: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Extract existing directives from a section for dedup checking.
 */
function extractSectionDirectives(content: string, sectionTitle: string): string[] {
  const lines = content.split("\n")
  let inSection = false
  const directives: string[] = []

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headerMatch) {
      inSection = headerMatch[1].trim().toLowerCase() === sectionTitle.toLowerCase()
      continue
    }
    if (inSection && line.match(/^[-*+]\s+/)) {
      directives.push(line.replace(/^[-*+]\s+/, "").trim())
    }
  }

  return directives
}

/**
 * Append a directive to a specific section. Creates the section if missing.
 */
function appendDirectiveToSection(
  content: string,
  sectionTitle: string,
  directive: string,
): string {
  const lines = content.split("\n")
  const sectionHeader = `## ${sectionTitle}`
  let sectionIndex = -1

  // Find the section
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === sectionHeader) {
      sectionIndex = i
      break
    }
  }

  if (sectionIndex === -1) {
    // Section doesn't exist — append at the end
    const newContent = content.trimEnd()
    return `${newContent}\n\n${sectionHeader}\n\n- ${directive}\n`
  }

  // Find the end of the section (next header or EOF)
  let insertIndex = lines.length
  for (let i = sectionIndex + 1; i < lines.length; i++) {
    if (lines[i].match(/^#{1,6}\s+/)) {
      insertIndex = i
      break
    }
  }

  // Insert the directive before the next section
  // Find last non-empty line in section to insert after
  let lastContentLine = sectionIndex
  for (let i = insertIndex - 1; i > sectionIndex; i--) {
    if (lines[i].trim() !== "") {
      lastContentLine = i
      break
    }
  }

  lines.splice(lastContentLine + 1, 0, `- ${directive}`)

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

interface HistoryEntry {
  timestamp: string
  action: "add" | "edit" | "delete" | "promote" | "demote"
  directive: string
  category: InstructionCategory
  scope: InstructionScope
  previousValue?: string
}

function getHistoryPath(projectPath?: string): string {
  if (projectPath) {
    return path.join(projectPath, ".era", "memory", "directives-history.json")
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  return path.join(home, ".era", "memory", "directives-history.json")
}

function appendHistory(entry: HistoryEntry, projectPath?: string): void {
  const historyPath = getHistoryPath(projectPath)
  ensureDirectoryExists(historyPath)

  let entries: HistoryEntry[] = []
  try {
    const raw = fs.readFileSync(historyPath, "utf-8")
    entries = JSON.parse(raw)
  } catch {
    // File doesn't exist or invalid JSON
  }

  entries.push(entry)

  // Keep last 100
  if (entries.length > 100) {
    entries = entries.slice(-100)
  }

  fs.writeFileSync(historyPath, JSON.stringify(entries, null, 2))
}

// ---------------------------------------------------------------------------
// Conflict Detection
// ---------------------------------------------------------------------------

const OPPOSITION_PAIRS: Array<[RegExp, RegExp]> = [
  [/\balways\b/i, /\bnever\b/i],
  [/\bprefer\b/i, /\bavoid\b/i],
  [/\buse\b/i, /\bdon['']?t use\b/i],
  [/\benable\b/i, /\bdisable\b/i],
  [/\brequire\b/i, /\bdon['']?t require\b/i],
]

function detectSemanticOpposition(a: string, b: string): boolean {
  const normA = a.toLowerCase()
  const normB = b.toLowerCase()

  for (const [patA, patB] of OPPOSITION_PAIRS) {
    if ((patA.test(normA) && patB.test(normB)) || (patB.test(normA) && patA.test(normB))) {
      // Also check that the rest of the instruction is topically similar
      const sim = textSimilarity(
        normA.replace(/\b(always|never|prefer|avoid|use|don't use|enable|disable|require|don't require)\b/gi, ""),
        normB.replace(/\b(always|never|prefer|avoid|use|don't use|enable|disable|require|don't require)\b/gi, ""),
      )
      if (sim > 0.4) return true
    }
  }

  return false
}

function detectConflicts(
  instruction: string,
  existingDirectives: string[],
  category: InstructionCategory,
  scope: InstructionScope,
  existingScopes?: Array<{ text: string; scope: InstructionScope }>,
): ConflictInfo[] {
  const conflicts: ConflictInfo[] = []

  for (const existing of existingDirectives) {
    // Semantic opposition: "always X" vs "never X"
    if (detectSemanticOpposition(instruction, existing)) {
      conflicts.push({
        type: "semantic_opposition",
        existingInstruction: existing,
        similarity: textSimilarity(instruction, existing),
        recommendation: "The new instruction contradicts an existing one. Consider editing the existing instruction instead.",
      })
    }

    // Category overlap: same category, moderate similarity, different guidance
    const sim = textSimilarity(instruction, existing)
    if (sim > 0.4 && sim <= 0.85 && !detectSemanticOpposition(instruction, existing)) {
      conflicts.push({
        type: "category_overlap",
        existingInstruction: existing,
        similarity: sim,
        recommendation: "A similar instruction exists in the same category. You may want to merge them.",
      })
    }
  }

  // Scope conflict: project says A, global says B
  if (existingScopes) {
    for (const es of existingScopes) {
      if (es.scope !== scope && textSimilarity(instruction, es.text) > 0.4) {
        if (detectSemanticOpposition(instruction, es.text)) {
          conflicts.push({
            type: "scope_conflict",
            existingInstruction: es.text,
            similarity: textSimilarity(instruction, es.text),
            recommendation: scope === "project"
              ? "This project instruction conflicts with a global one. The project rule will take precedence."
              : "This global instruction conflicts with a project-specific one. The project rule may take precedence.",
          })
        }
      }
    }
  }

  return conflicts
}

// ---------------------------------------------------------------------------
// Directive Mutation Helpers
// ---------------------------------------------------------------------------

function removeDirectiveFromSection(
  content: string,
  sectionTitle: string,
  directiveText: string,
): string {
  const lines = content.split("\n")
  const sectionHeader = `## ${sectionTitle}`
  let inSection = false
  let removed = false

  const result: string[] = []

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headerMatch) {
      inSection = line.trim() === sectionHeader
    }

    if (inSection && !removed && line.match(/^[-*+]\s+/)) {
      const text = line.replace(/^[-*+]\s+/, "").trim()
      if (text === directiveText) {
        removed = true
        continue // skip this line
      }
    }

    result.push(line)
  }

  return result.join("\n")
}

function replaceDirectiveInSection(
  content: string,
  sectionTitle: string,
  oldText: string,
  newText: string,
): string {
  const lines = content.split("\n")
  const sectionHeader = `## ${sectionTitle}`
  let inSection = false
  let replaced = false

  const result: string[] = []

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headerMatch) {
      inSection = line.trim() === sectionHeader
    }

    if (inSection && !replaced && line.match(/^[-*+]\s+/)) {
      const text = line.replace(/^[-*+]\s+/, "").trim()
      if (text === oldText) {
        result.push(`- ${newText}`)
        replaced = true
        continue
      }
    }

    result.push(line)
  }

  return result.join("\n")
}

/**
 * Extract all directives from all sections with their category info.
 */
function extractAllDirectives(content: string): Array<{ text: string; section: string }> {
  const lines = content.split("\n")
  let currentSection = ""
  const directives: Array<{ text: string; section: string }> = []

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)$/)
    if (headerMatch) {
      currentSection = headerMatch[1].trim()
      continue
    }
    if (currentSection && line.match(/^[-*+]\s+/)) {
      directives.push({
        text: line.replace(/^[-*+]\s+/, "").trim(),
        section: currentSection,
      })
    }
  }

  return directives
}

// ---------------------------------------------------------------------------
// Main Writer
// ---------------------------------------------------------------------------

export class GovernanceWriter {
  private memoryClient: EraMemoryClient

  constructor(memoryClient?: EraMemoryClient) {
    this.memoryClient = memoryClient ?? new EraMemoryClient()
  }

  async writeInstruction(req: WriteInstructionRequest): Promise<WriteInstructionResponse> {
    const storageTarget = req.storageOverride ?? CATEGORY_STORAGE[req.category] ?? "directive"
    const sectionTitle = CATEGORY_SECTION[req.category] ?? "General"
    const projectPath = req.scope === "project" ? req.projectPath : undefined

    const response: WriteInstructionResponse = {
      stored: false,
      storageType: storageTarget,
      deduplicated: false,
    }

    // --- Write to directive ---
    if (storageTarget === "directive" || storageTarget === "both") {
      const directivePath = getDirectivesPath(projectPath)
      const content = readDirectivesFile(directivePath)

      // Dedup check
      const existing = extractSectionDirectives(content, sectionTitle)
      for (const ex of existing) {
        const sim = textSimilarity(ex, req.instruction)
        if (sim > 0.85) {
          response.deduplicated = true
          response.stored = true
          response.directiveId = ex
          return response
        }
      }

      // Conflict detection
      const allDirectives = extractAllDirectives(content).map((d) => d.text)
      // Also check cross-scope conflicts
      const otherScopePath = getDirectivesPath(projectPath ? undefined : req.projectPath)
      const otherScopeContent = readDirectivesFile(otherScopePath)
      const otherScopeDirectives = extractAllDirectives(otherScopeContent).map((d) => ({
        text: d.text,
        scope: (projectPath ? "global" : "project") as InstructionScope,
      }))

      const conflicts = detectConflicts(
        req.instruction,
        allDirectives,
        req.category,
        req.scope,
        otherScopeDirectives,
      )
      if (conflicts.length > 0) {
        response.conflicts = conflicts
      }

      ensureDirectoryExists(directivePath)
      const updated = appendDirectiveToSection(content, sectionTitle, req.instruction)
      fs.writeFileSync(directivePath, updated)

      response.directiveId = req.instruction
      response.stored = true

      // Record history
      appendHistory(
        {
          timestamp: new Date().toISOString(),
          action: "add",
          directive: req.instruction,
          category: req.category,
          scope: req.scope,
        },
        projectPath,
      )
    }

    // --- Write to Era Memory ---
    if (storageTarget === "memory" || storageTarget === "both") {
      try {
        const memoryAvailable = await this.memoryClient.isAvailable()
        if (!memoryAvailable) {
          // Graceful fallback
          if (storageTarget === "memory" && !response.stored) {
            // Memory-only but unavailable — fall back to directive
            const directivePath = getDirectivesPath(projectPath)
            const content = readDirectivesFile(directivePath)
            ensureDirectoryExists(directivePath)
            const updated = appendDirectiveToSection(content, sectionTitle, req.instruction)
            fs.writeFileSync(directivePath, updated)
            response.stored = true
            response.storageType = "directive"
            response.warning = "Era Memory unavailable — saved as directive instead"

            appendHistory(
              {
                timestamp: new Date().toISOString(),
                action: "add",
                directive: req.instruction,
                category: req.category,
                scope: req.scope,
              },
              projectPath,
            )
          } else if (storageTarget === "both") {
            response.warning = "Era Memory unavailable — saved as directive only"
          }
          return response
        }

        // Dedup check via vector search
        const searchResults: MemorySearchResult[] = await this.memoryClient.search({
          query: req.instruction,
          type: "preference",
          limit: 3,
          minScore: 0.7,
        })

        if (searchResults.some((r) => r.score > 0.85)) {
          response.deduplicated = true
          if (!response.stored) {
            response.stored = true
          }
          return response
        }

        const memory = await this.memoryClient.create({
          content: req.instruction,
          type: "preference",
          metadata: {
            category: req.category,
            scope: req.scope,
            projectPath: projectPath ?? null,
            source: "instruction-capture",
            accessCount: 0,
          },
        })

        response.memoryId = memory.id
        response.stored = true
      } catch (err) {
        // Memory write failed
        if (storageTarget === "memory" && !response.stored) {
          response.stored = false
          response.warning = `Era Memory error: ${err instanceof Error ? err.message : "unknown"}`
        } else if (storageTarget === "both") {
          response.warning = `Memory write failed but directive saved: ${err instanceof Error ? err.message : "unknown"}`
        }
      }
    }

    return response
  }

  /**
   * Delete an instruction from directive file or Era Memory.
   */
  async deleteInstruction(req: DeleteInstructionRequest): Promise<{ success: boolean; warning?: string }> {
    if (req.storageType === "directive") {
      const sectionTitle = req.category ? CATEGORY_SECTION[req.category] : undefined
      const directivePath = getDirectivesPath(req.projectPath)
      const content = readDirectivesFile(directivePath)

      if (!content) return { success: false, warning: "Directives file not found" }

      // If we have a section, remove from that section specifically
      if (sectionTitle) {
        const updated = removeDirectiveFromSection(content, sectionTitle, req.id)
        fs.writeFileSync(directivePath, updated)
      } else {
        // Search all sections for this directive text
        const allDirectives = extractAllDirectives(content)
        const match = allDirectives.find((d) => d.text === req.id)
        if (match) {
          const updated = removeDirectiveFromSection(content, match.section, req.id)
          fs.writeFileSync(directivePath, updated)
        } else {
          return { success: false, warning: "Directive not found" }
        }
      }

      appendHistory(
        {
          timestamp: new Date().toISOString(),
          action: "delete",
          directive: req.id,
          category: req.category ?? "workflow",
          scope: req.projectPath ? "project" : "global",
        },
        req.projectPath,
      )

      return { success: true }
    }

    // Era Memory deletion
    try {
      const available = await this.memoryClient.isAvailable()
      if (!available) return { success: false, warning: "Era Memory unavailable" }
      await this.memoryClient.delete(req.id)
      return { success: true }
    } catch (err) {
      return { success: false, warning: err instanceof Error ? err.message : "Unknown error" }
    }
  }

  /**
   * Edit an existing instruction in directive file or Era Memory.
   */
  async editInstruction(req: EditInstructionRequest): Promise<{ success: boolean; warning?: string }> {
    if (req.storageType === "directive") {
      const sectionTitle = req.category ? CATEGORY_SECTION[req.category] : undefined
      const directivePath = getDirectivesPath(req.projectPath)
      const content = readDirectivesFile(directivePath)

      if (!content) return { success: false, warning: "Directives file not found" }

      if (sectionTitle) {
        const updated = replaceDirectiveInSection(content, sectionTitle, req.id, req.newContent)
        fs.writeFileSync(directivePath, updated)
      } else {
        const allDirectives = extractAllDirectives(content)
        const match = allDirectives.find((d) => d.text === req.id)
        if (match) {
          const updated = replaceDirectiveInSection(content, match.section, req.id, req.newContent)
          fs.writeFileSync(directivePath, updated)
        } else {
          return { success: false, warning: "Directive not found" }
        }
      }

      appendHistory(
        {
          timestamp: new Date().toISOString(),
          action: "edit",
          directive: req.newContent,
          category: req.category ?? "workflow",
          scope: req.projectPath ? "project" : "global",
          previousValue: req.id,
        },
        req.projectPath,
      )

      return { success: true }
    }

    // Era Memory edit
    try {
      const available = await this.memoryClient.isAvailable()
      if (!available) return { success: false, warning: "Era Memory unavailable" }
      await this.memoryClient.update(req.id, { content: req.newContent })
      return { success: true }
    } catch (err) {
      return { success: false, warning: err instanceof Error ? err.message : "Unknown error" }
    }
  }

  /**
   * Promote a memory instruction to a directive (memory → directive).
   */
  async promoteInstruction(req: PromoteRequest): Promise<WriteInstructionResponse> {
    const projectPath = req.scope === "project" ? req.projectPath : undefined

    // Write as directive
    const result = await this.writeInstruction({
      instruction: req.content,
      category: req.category,
      scope: req.scope,
      storageOverride: "directive",
      projectPath: req.projectPath,
    })

    if (result.stored) {
      // Delete from memory
      try {
        const available = await this.memoryClient.isAvailable()
        if (available) {
          await this.memoryClient.delete(req.id)
        }
      } catch {
        result.warning = "Promoted to directive but failed to remove from memory"
      }

      appendHistory(
        {
          timestamp: new Date().toISOString(),
          action: "promote",
          directive: req.content,
          category: req.category,
          scope: req.scope,
        },
        projectPath,
      )
    }

    return result
  }

  /**
   * Demote a directive to a memory instruction (directive → memory).
   */
  async demoteInstruction(req: PromoteRequest): Promise<WriteInstructionResponse> {
    const projectPath = req.scope === "project" ? req.projectPath : undefined
    const sectionTitle = CATEGORY_SECTION[req.category] ?? "General"

    // Remove from directive file
    const directivePath = getDirectivesPath(projectPath)
    const content = readDirectivesFile(directivePath)
    const updated = removeDirectiveFromSection(content, sectionTitle, req.content)
    fs.writeFileSync(directivePath, updated)

    // Write to memory
    const result = await this.writeInstruction({
      instruction: req.content,
      category: req.category,
      scope: req.scope,
      storageOverride: "memory",
      projectPath: req.projectPath,
    })

    if (result.stored) {
      appendHistory(
        {
          timestamp: new Date().toISOString(),
          action: "demote",
          directive: req.content,
          category: req.category,
          scope: req.scope,
        },
        projectPath,
      )
    }

    return result
  }

  /**
   * List all saved instructions (directives + memories).
   */
  async listInstructions(req: ListInstructionsRequest): Promise<SavedInstruction[]> {
    const results: SavedInstruction[] = []

    // --- Gather directives ---
    const scopes: InstructionScope[] = req.scope ? [req.scope] : ["project", "global"]

    for (const scope of scopes) {
      const projectPath = scope === "project" ? req.projectPath : undefined
      const directivePath = getDirectivesPath(projectPath)
      const content = readDirectivesFile(directivePath)
      if (!content) continue

      const allDirectives = extractAllDirectives(content)
      for (const d of allDirectives) {
        // Reverse-map section name to category
        const cat = Object.entries(CATEGORY_SECTION).find(
          ([, heading]) => heading.toLowerCase() === d.section.toLowerCase(),
        )
        results.push({
          id: d.text,
          content: d.text,
          category: (cat?.[0] as InstructionCategory) ?? "workflow",
          scope,
          storageType: "directive",
          projectPath,
        })
      }
    }

    // --- Gather memories ---
    try {
      const available = await this.memoryClient.isAvailable()
      if (available) {
        const memories = await this.memoryClient.search({
          query: "development preferences instructions",
          type: "preference",
          limit: 100,
          minScore: 0.1,
        })

        for (const m of memories) {
          const meta = (m.memory.metadata ?? {}) as Record<string, unknown>
          const memScope = (meta.scope as string) ?? "global"
          const memProject = meta.projectPath as string | undefined

          // Filter by requested scope
          if (req.scope && memScope !== req.scope) continue
          if (req.scope === "project" && memProject !== req.projectPath) continue

          results.push({
            id: m.memory.id,
            content: m.memory.content,
            category: (meta.category as InstructionCategory) ?? "style",
            scope: memScope as InstructionScope,
            storageType: "memory",
            createdAt: m.memory.createdAt,
            accessCount: (meta.accessCount as number) ?? 0,
            projectPath: memProject,
          })
        }
      }
    } catch {
      // Memory unavailable — return directives only
    }

    return results
  }
}
