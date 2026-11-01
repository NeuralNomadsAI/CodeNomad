import { MissionTaskPageReadError } from "./mission-task-read-lifetime"

// A requested 50-task / 200-report compact window, not a mission-count limit.
// The journal allows 24 dependencies of 240 UTF-16 units per task. Even maximally
// escaped known rows (bindings, 2 nested reports, 4 report bodies) fit below 8 Mi
// JSON units. Extensions share the remaining room, and never silently truncate.
export const TASK_WINDOW_CHARACTERS = 8 * 1024 * 1024
export const TASK_WINDOW_UTF8_BYTES = 3 * TASK_WINDOW_CHARACTERS
export const TASK_WINDOW_WIRE_BYTES = 64 * 1024 * 1024
export const TASK_WINDOW_TOKENS = 256 * 1024
export const TASK_WINDOW_DEPTH = 24

/** Scan before concatenation / JSON.parse: unknown metadata is subject to the same
 * bounded text, structural-token and nesting budgets as known compact fields. */
export class MissionTaskWindowBudget {
  private characters = 0
  private bytes = 0
  private tokens = 0
  private depth = 0
  private quoted = false
  private escaped = false
  private wireBytes = 0

  transfer(bytes: number): void {
    this.wireBytes += bytes
    if (this.wireBytes > TASK_WINDOW_WIRE_BYTES) throw new MissionTaskPageReadError("too-large")
  }
  append(text: string, advertised: number): void {
    this.characters += text.length
    if (advertised > TASK_WINDOW_CHARACTERS || this.characters > TASK_WINDOW_CHARACTERS) throw new MissionTaskPageReadError("too-large")
    this.bytes += new TextEncoder().encode(text).length // a single transfer's bounded piece
    if (this.bytes > TASK_WINDOW_UTF8_BYTES) throw new MissionTaskPageReadError("too-large")
    for (const char of text) {
      if (this.quoted) {
        if (this.escaped) this.escaped = false
        else if (char === "\\") this.escaped = true
        else if (char === '"') this.quoted = false
      } else if (char === '"') this.quoted = true
      else if (char === "{" || char === "[") { this.depth++; this.tokens++ }
      else if (char === "}" || char === "]") this.depth--
      else if (char === "," || char === ":") this.tokens++
      if (this.depth < 0) throw new MissionTaskPageReadError("invalid")
      if (this.depth > TASK_WINDOW_DEPTH || this.tokens > TASK_WINDOW_TOKENS) throw new MissionTaskPageReadError("too-large")
    }
  }
}
