/**
 * Merge Service
 *
 * Provides 3-way merge functionality for text files using diff-match-patch.
 * Handles automatic merging when changes don't overlap and generates
 * conflict markers when manual resolution is required.
 */

import DiffMatchPatch from "diff-match-patch"
import { isBinaryFile, BinaryDetectionResult } from "./binary-detector.js"
import { createLogger, Logger } from "../logger.js"

export interface MergeRequest {
  /** File path (for logging/error messages) */
  filePath: string
  /** Common ancestor content */
  base: string
  /** Session A's version ("ours") */
  ours: string
  /** Session B's version ("theirs") */
  theirs: string
}

export interface ConflictRegion {
  /** Line number where conflict starts (0-indexed) */
  startLine: number
  /** Line number where conflict ends (0-indexed, inclusive) */
  endLine: number
  /** Base version of conflicting text */
  base: string
  /** Our version of conflicting text */
  ours: string
  /** Their version of conflicting text */
  theirs: string
}

export interface MergeResult {
  /** Whether merge completed without conflicts */
  success: boolean
  /** Merged content (may contain conflict markers if hasConflicts is true) */
  merged: string | null
  /** Whether conflict markers are present in merged content */
  hasConflicts: boolean
  /** Individual conflict regions */
  conflicts: ConflictRegion[]
  /** Merge statistics */
  stats: {
    baseLines: number
    oursAddedLines: number
    oursRemovedLines: number
    theirsAddedLines: number
    theirsRemovedLines: number
    autoMergedRegions: number
    conflictingRegions: number
  }
}

export interface MergeServiceOptions {
  /** Conflict marker style (default: 'git') */
  markerStyle?: "git" | "diff3"
  /** Logger instance */
  logger?: Logger
}

// Diff constants from diff-match-patch
const DIFF_DELETE = -1
const DIFF_EQUAL = 0
const DIFF_INSERT = 1

export class MergeService {
  private dmp: DiffMatchPatch
  private markerStyle: "git" | "diff3"
  private log: Logger

  constructor(options: MergeServiceOptions = {}) {
    this.dmp = new DiffMatchPatch()
    // Increase timeout for large files
    this.dmp.Diff_Timeout = 5.0
    // Optimal edit cost for better merges
    this.dmp.Diff_EditCost = 4
    this.markerStyle = options.markerStyle ?? "git"
    this.log = options.logger ?? createLogger({ component: "merge-service" })
  }

  /**
   * Perform a 3-way merge
   */
  merge(request: MergeRequest): MergeResult {
    const { filePath, base, ours, theirs } = request

    this.log.debug({ filePath }, "Starting 3-way merge")

    // Check if any version is binary
    const baseCheck = isBinaryFile(Buffer.from(base), filePath)
    const oursCheck = isBinaryFile(Buffer.from(ours), filePath)
    const theirsCheck = isBinaryFile(Buffer.from(theirs), filePath)

    if (baseCheck.isBinary || oursCheck.isBinary || theirsCheck.isBinary) {
      this.log.debug({ filePath }, "Binary file detected, cannot auto-merge")
      return {
        success: false,
        merged: null,
        hasConflicts: true,
        conflicts: [
          {
            startLine: 0,
            endLine: 0,
            base: "[Binary file]",
            ours: "[Binary file]",
            theirs: "[Binary file]",
          },
        ],
        stats: {
          baseLines: 0,
          oursAddedLines: 0,
          oursRemovedLines: 0,
          theirsAddedLines: 0,
          theirsRemovedLines: 0,
          autoMergedRegions: 0,
          conflictingRegions: 1,
        },
      }
    }

    // If ours equals theirs, no conflict
    if (ours === theirs) {
      return {
        success: true,
        merged: ours,
        hasConflicts: false,
        conflicts: [],
        stats: this.computeStats(base, ours, theirs, 0),
      }
    }

    // If ours equals base, take theirs
    if (ours === base) {
      return {
        success: true,
        merged: theirs,
        hasConflicts: false,
        conflicts: [],
        stats: this.computeStats(base, ours, theirs, 0),
      }
    }

    // If theirs equals base, take ours
    if (theirs === base) {
      return {
        success: true,
        merged: ours,
        hasConflicts: false,
        conflicts: [],
        stats: this.computeStats(base, ours, theirs, 0),
      }
    }

    // Perform line-by-line 3-way merge
    return this.performLineMerge(base, ours, theirs, filePath)
  }

  /**
   * Line-by-line 3-way merge
   * First checks for conflicts at line level, then attempts patch-based merge if no conflicts
   */
  private performLineMerge(
    base: string,
    ours: string,
    theirs: string,
    filePath: string
  ): MergeResult {
    // First, do a simple line-level check to detect any conflicts
    const lineCheck = this.checkLineConflicts(base, ours, theirs)

    if (lineCheck.hasConflicts) {
      // Use simple line merge which will include conflict markers
      return this.performSimpleLineMerge(base, ours, theirs, filePath)
    }

    // No line-level conflicts detected, use patch-based merge for best results
    const ourDiffs = this.dmp.diff_main(base, ours)
    this.dmp.diff_cleanupSemantic(ourDiffs)
    const ourPatches = this.dmp.patch_make(base, ourDiffs)

    const [mergedFromTheirs, ourPatchResults] = this.dmp.patch_apply(ourPatches, theirs)
    const allApplied = ourPatchResults.every((r) => r)

    if (allApplied) {
      this.log.debug({ filePath }, "Clean patch-based merge achieved")
      return {
        success: true,
        merged: mergedFromTheirs,
        hasConflicts: false,
        conflicts: [],
        stats: this.computeStats(base, ours, theirs, 0),
      }
    }

    // Patches didn't apply cleanly, fall back to simple line merge
    return this.performSimpleLineMerge(base, ours, theirs, filePath)
  }

  /**
   * Check if there are any line-level conflicts
   * Returns true if both sides modified the same line differently
   */
  private checkLineConflicts(base: string, ours: string, theirs: string): { hasConflicts: boolean } {
    const baseLines = base.split("\n")
    const ourLines = ours.split("\n")
    const theirLines = theirs.split("\n")

    const maxLen = Math.max(baseLines.length, ourLines.length, theirLines.length)

    for (let i = 0; i < maxLen; i++) {
      const baseLine = i < baseLines.length ? baseLines[i] : null
      const ourLine = i < ourLines.length ? ourLines[i] : null
      const theirLine = i < theirLines.length ? theirLines[i] : null

      // Both changed the same line differently from base and from each other = conflict
      const weChanged = ourLine !== baseLine
      const theyChanged = theirLine !== baseLine
      const differentFromEachOther = ourLine !== theirLine

      if (weChanged && theyChanged && differentFromEachOther) {
        return { hasConflicts: true }
      }
    }

    return { hasConflicts: false }
  }

  /**
   * Simple line-by-line merge for conflict detection
   */
  private performSimpleLineMerge(
    base: string,
    ours: string,
    theirs: string,
    filePath: string
  ): MergeResult {
    const baseLines = base.split("\n")
    const ourLines = ours.split("\n")
    const theirLines = theirs.split("\n")

    const mergedLines: string[] = []
    const conflicts: ConflictRegion[] = []
    let mergedLineIdx = 0

    // Use longest common subsequence approach
    const maxLen = Math.max(baseLines.length, ourLines.length, theirLines.length)

    for (let i = 0; i < maxLen; i++) {
      const baseLine = i < baseLines.length ? baseLines[i] : null
      const ourLine = i < ourLines.length ? ourLines[i] : null
      const theirLine = i < theirLines.length ? theirLines[i] : null

      // If all three are the same, take it
      if (baseLine === ourLine && ourLine === theirLine) {
        if (baseLine !== null) {
          mergedLines.push(baseLine)
          mergedLineIdx++
        }
        continue
      }

      // If only ours changed from base, take ours
      if (baseLine === theirLine && ourLine !== baseLine) {
        if (ourLine !== null) {
          mergedLines.push(ourLine)
          mergedLineIdx++
        }
        // If ourLine is null, it was deleted
        continue
      }

      // If only theirs changed from base, take theirs
      if (baseLine === ourLine && theirLine !== baseLine) {
        if (theirLine !== null) {
          mergedLines.push(theirLine)
          mergedLineIdx++
        }
        // If theirLine is null, it was deleted
        continue
      }

      // If both changed to the same thing, take it
      if (ourLine === theirLine) {
        if (ourLine !== null) {
          mergedLines.push(ourLine)
          mergedLineIdx++
        }
        continue
      }

      // Conflict: both changed differently
      const startLine = mergedLineIdx
      mergedLines.push("<<<<<<< ours")
      mergedLineIdx++
      if (ourLine !== null) {
        mergedLines.push(ourLine)
        mergedLineIdx++
      }
      mergedLines.push("=======")
      mergedLineIdx++
      if (theirLine !== null) {
        mergedLines.push(theirLine)
        mergedLineIdx++
      }
      mergedLines.push(">>>>>>> theirs")
      mergedLineIdx++

      conflicts.push({
        startLine,
        endLine: mergedLineIdx - 1,
        base: baseLine ?? "",
        ours: ourLine ?? "",
        theirs: theirLine ?? "",
      })
    }

    const merged = mergedLines.join("\n")
    const hasConflicts = conflicts.length > 0

    this.log.debug(
      { filePath, hasConflicts, conflictCount: conflicts.length },
      "Simple merge complete"
    )

    return {
      success: !hasConflicts,
      merged,
      hasConflicts,
      conflicts,
      stats: this.computeStats(base, ours, theirs, conflicts.length),
    }
  }

  /**
   * Compute line-level diff between two versions
   */
  private computeLineDiff(oldLines: string[], newLines: string[]): DiffMatchPatch.Diff[] {
    const oldText = oldLines.join("\n")
    const newText = newLines.join("\n")

    // Use diff-match-patch for character-level diff
    const diffs = this.dmp.diff_main(oldText, newText)
    this.dmp.diff_cleanupSemantic(diffs)

    return diffs
  }

  /**
   * Index changes by base line number
   */
  private indexChanges(diffs: DiffMatchPatch.Diff[]): Map<number, Change> {
    const changes = new Map<number, Change>()
    let baseLineIdx = 0
    let newLineIdx = 0
    let currentBasePos = 0
    let currentNewPos = 0

    for (const [op, text] of diffs) {
      const lines = text.split("\n")

      if (op === DIFF_EQUAL) {
        currentBasePos += text.length
        currentNewPos += text.length
        baseLineIdx += lines.length - 1
        newLineIdx += lines.length - 1
      } else if (op === DIFF_DELETE) {
        changes.set(baseLineIdx, {
          type: "delete",
          lines: lines,
          oldLines: lines,
          newLines: [],
        })
        currentBasePos += text.length
        baseLineIdx += lines.length - 1
      } else if (op === DIFF_INSERT) {
        const existing = changes.get(baseLineIdx)
        if (existing && existing.type === "delete") {
          existing.type = "modify"
          existing.newLines = lines
        } else {
          changes.set(baseLineIdx, {
            type: "insert",
            lines: lines,
            oldLines: [],
            newLines: lines,
          })
        }
        currentNewPos += text.length
        newLineIdx += lines.length - 1
      }
    }

    return changes
  }

  /**
   * Check if two changes conflict
   */
  private checkForConflict(
    ourChange: Change,
    theirChange: Change,
    baseLines: string[],
    ourLines: string[],
    theirLines: string[],
    baseIdx: number
  ): ConflictCheck {
    // If both made the same change, no conflict
    if (
      ourChange.type === theirChange.type &&
      this.arraysEqual(ourChange.newLines, theirChange.newLines)
    ) {
      return {
        isConflict: false,
        mergedLines: ourChange.newLines,
        baseLines: ourChange.oldLines,
        ourLines: ourChange.newLines,
        theirLines: theirChange.newLines,
        baseAdvance: ourChange.oldLines.length || 1,
        ourAdvance: ourChange.newLines.length || 1,
        theirAdvance: theirChange.newLines.length || 1,
      }
    }

    // Different changes on the same region = conflict
    return {
      isConflict: true,
      mergedLines: [],
      baseLines: ourChange.oldLines.length > 0 ? ourChange.oldLines : theirChange.oldLines,
      ourLines: ourChange.newLines,
      theirLines: theirChange.newLines,
      baseAdvance: Math.max(ourChange.oldLines.length, theirChange.oldLines.length) || 1,
      ourAdvance: ourChange.newLines.length || 1,
      theirAdvance: theirChange.newLines.length || 1,
    }
  }

  /**
   * Check if two arrays are equal
   */
  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  /**
   * Compute merge statistics
   */
  private computeStats(
    base: string,
    ours: string,
    theirs: string,
    conflictCount: number
  ): MergeResult["stats"] {
    const baseLines = base.split("\n").length
    const ourDiffs = this.dmp.diff_main(base, ours)
    const theirDiffs = this.dmp.diff_main(base, theirs)

    let oursAddedLines = 0
    let oursRemovedLines = 0
    let theirsAddedLines = 0
    let theirsRemovedLines = 0

    for (const [op, text] of ourDiffs) {
      const lines = text.split("\n").length - 1
      if (op === DIFF_INSERT) oursAddedLines += lines
      if (op === DIFF_DELETE) oursRemovedLines += lines
    }

    for (const [op, text] of theirDiffs) {
      const lines = text.split("\n").length - 1
      if (op === DIFF_INSERT) theirsAddedLines += lines
      if (op === DIFF_DELETE) theirsRemovedLines += lines
    }

    return {
      baseLines,
      oursAddedLines,
      oursRemovedLines,
      theirsAddedLines,
      theirsRemovedLines,
      autoMergedRegions: Math.max(0, (oursAddedLines + theirsAddedLines) - conflictCount),
      conflictingRegions: conflictCount,
    }
  }

  /**
   * Check if content is binary
   */
  isBinary(content: Buffer | string, filePath?: string): BinaryDetectionResult {
    const buffer = typeof content === "string" ? Buffer.from(content) : content
    return isBinaryFile(buffer, filePath)
  }

  /**
   * Apply patches to content
   * Useful for applying one side's changes to another
   */
  applyPatch(original: string, patched: string, target: string): string {
    const diffs = this.dmp.diff_main(original, patched)
    const patches = this.dmp.patch_make(original, diffs)
    const [result] = this.dmp.patch_apply(patches, target)
    return result
  }

  /**
   * Generate a unified diff between two strings
   */
  generateDiff(oldText: string, newText: string): string {
    const diffs = this.dmp.diff_main(oldText, newText)
    this.dmp.diff_cleanupSemantic(diffs)

    const lines: string[] = []
    let oldLine = 1
    let newLine = 1

    for (const [op, text] of diffs) {
      const textLines = text.split("\n")
      for (let i = 0; i < textLines.length; i++) {
        const line = textLines[i]
        const isLastLine = i === textLines.length - 1
        const addNewline = !isLastLine || text.endsWith("\n")

        if (op === DIFF_EQUAL) {
          if (line || !isLastLine) {
            lines.push(` ${line}`)
            if (!isLastLine) {
              oldLine++
              newLine++
            }
          }
        } else if (op === DIFF_DELETE) {
          if (line || !isLastLine) {
            lines.push(`-${line}`)
            if (!isLastLine) oldLine++
          }
        } else if (op === DIFF_INSERT) {
          if (line || !isLastLine) {
            lines.push(`+${line}`)
            if (!isLastLine) newLine++
          }
        }
      }
    }

    return lines.join("\n")
  }
}

interface Change {
  type: "insert" | "delete" | "modify"
  lines: string[]
  oldLines: string[]
  newLines: string[]
}

interface ConflictCheck {
  isConflict: boolean
  mergedLines: string[]
  baseLines: string[]
  ourLines: string[]
  theirLines: string[]
  baseAdvance: number
  ourAdvance: number
  theirAdvance: number
}

// Singleton instance
let mergeServiceInstance: MergeService | null = null

export function getMergeService(): MergeService {
  if (!mergeServiceInstance) {
    mergeServiceInstance = new MergeService()
  }
  return mergeServiceInstance
}

export function createMergeService(options?: MergeServiceOptions): MergeService {
  mergeServiceInstance = new MergeService(options)
  return mergeServiceInstance
}
