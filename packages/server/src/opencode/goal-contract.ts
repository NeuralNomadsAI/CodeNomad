import { z } from "zod"

// OpenCode's built-in `/goal` plugin (`@opencode/schema/goal`; dev-docs/OPENCODE_COMPATIBILITY.md, Session goal):
// `get({ sessionID })` answers the Session's own goal or null, every write publishes
// `changed` in the Session's Location, and `/goal pause|resume|clear` change it.
export const GOAL_RPC_ID = "opencode.goal"
export const GOAL_CHANGED_EVENT = "rpc.opencode.goal.changed"
export const GOAL_COMMAND = "goal"
export type GoalCommandAction = "pause" | "resume" | "clear"

// Only the displayed fields; unknown fields are dropped. Bounds sit far above the
// plugin's own (4,000-character objectives) and reject only malformed answers.
export const goalStateSchema = z.object({
  id: z.string().min(1).max(256),
  objective: z.string().max(64 * 1024),
  status: z.enum(["active", "paused", "complete"]),
  reason: z.string().max(16 * 1024).optional(),
  rounds: z.number().int().nonnegative(),
  maxRounds: z.number().int().nonnegative(),
  updatedAt: z.number(),
})
export type GoalState = z.infer<typeof goalStateSchema>

export const goalChangedSchema = z.object({ sessionID: z.string().min(1).max(512), goal: goalStateSchema.nullable() })

/** `GET /api/workspaces/:id/sessions/:sessionId/goal`: `unsupported` without the RPC, `unavailable` on any other failure. */
export type SessionGoalResponse = { status: "goal"; goal: GoalState | null } | { status: "unsupported" } | { status: "unavailable" }
