import {
  MissionControl,
} from "../missions/control"
import type {
  MissionDelegateInput,
  MissionInspectInput,
  MissionReportInput,
  MissionSessionAdapter,
} from "../missions/control-types"
import { MISSION_SCHEMA_VERSION, type MissionTemplateId } from "../missions/model"
import { CODENOMAD_MISSIONS_RPC } from "../missions/rpc"

interface Registration {
  dispose(): Promise<void>
}

interface ToolContext {
  readonly sessionID: string
  readonly messageID: string
  readonly id: string
  progress(update: Record<string, unknown>): Promise<void>
}

interface ToolDraft {
  namespace(namespace: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    options: { namespace: string; codemode: false }
    execute(input: unknown, context: ToolContext): Promise<{ content: string }>
  }): void
}

interface MissionsPluginContext {
  location: {
    directory: string
    workspaceID?: string
    project: { id: string; canonical: string }
  }
  storage: {
    get(key: string): Promise<unknown | undefined>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
    scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
      entries: readonly { key: string; value: unknown }[]
      next?: string
    }>
  }
  session: MissionSessionAdapter & {
    hook(name: "context", callback: (event: {
      sessionID: string
      system: Array<{ text: string }>
      tools: Record<string, unknown>
    }) => Promise<void> | void): Promise<Registration>
  }
  tool: {
    transform(callback: (draft: ToolDraft) => void): Promise<Registration>
  }
  rpc: {
    register(
      definition: typeof CODENOMAD_MISSIONS_RPC,
      handlers: { snapshot(input: unknown): Promise<unknown> },
    ): Promise<Registration & { events: { emit(name: "changed", data: { missionID: string; revision: number }): Promise<void> } }>
  }
}

export async function setupMissionsPlugin(context: MissionsPluginContext): Promise<() => Promise<void>> {
  let rpcRegistration: Awaited<ReturnType<MissionsPluginContext["rpc"]["register"]>> | undefined
  const control = new MissionControl({
    project: {
      id: context.location.project.id,
      canonical: context.location.project.canonical,
      location: { directory: context.location.directory, workspaceID: context.location.workspaceID },
    },
    storage: context.storage,
    sessions: context.session,
    changed: (missionID, revision) => rpcRegistration?.events.emit("changed", { missionID, revision }) ?? Promise.resolve(),
  })

  rpcRegistration = await context.rpc.register(CODENOMAD_MISSIONS_RPC, {
    snapshot: async () => control.snapshot(),
  })

  const tools = await context.tool.transform((draft) => {
    draft.namespace({
      name: "mission",
      description: "Coordinate visible OpenCode root sessions through a durable, agent-driven mission map.",
    })
    draft.add({
      name: "inspect",
      description: "Inspect the caller's durable mission map, or start a custom, Pocock bug-fix, or Wayfinder mission.",
      input: inspectSchema,
      options: { namespace: "mission", codemode: false },
      execute: async (input, tool) => {
        await tool.progress({ status: "Reading the mission map" })
        const result = await control.inspect(tool.sessionID, parseInspectInput(input), tool.id)
        return textResult(result)
      },
    })
    draft.add({
      name: "delegate",
      description: "Create or dispatch one dependency-aware task to a new or existing root session. Coordinator only.",
      input: delegateSchema,
      options: { namespace: "mission", codemode: false },
      execute: async (input, tool) => {
        await tool.progress({ status: "Delegating mission task" })
        return textResult(await control.delegate(tool.sessionID, parseDelegateInput(input)))
      },
    })
    draft.add({
      name: "report",
      description: "Report an assigned task back to the coordinator, or let the coordinator finish the mission.",
      input: reportSchema,
      options: { namespace: "mission", codemode: false },
      execute: async (input, tool) => {
        await tool.progress({ status: "Recording mission report" })
        return textResult(await control.report(tool.sessionID, parseReportInput(input)))
      },
    })
  })

  const contextHook = await context.session.hook("context", async (event) => {
    try {
      const instruction = await control.contextFor(event.sessionID)
      if (!instruction) return
      event.system.push({ text: instruction })
      const snapshot = await control.snapshot()
      const mission = snapshot.missions.find((candidate) => candidate.status === "active"
        && candidate.actors.some((actor) => actor.sessionId === event.sessionID))
      if (mission && mission.coordinatorSessionId !== event.sessionID) delete event.tools.mission_delegate
    } catch {
      // Mission context is additive. A damaged optional map must not block an otherwise valid model request.
    }
  })

  return async () => {
    await Promise.allSettled([contextHook.dispose(), tools.dispose(), rpcRegistration?.dispose() ?? Promise.resolve()])
  }
}

const inspectSchema = {
  type: "object",
  properties: {
    missionID: { type: "string", description: "Mission to inspect; omit to use the caller's active mission." },
    start: {
      type: "object",
      properties: {
        objective: { type: "string", minLength: 1, maxLength: 20_000 },
        template: { type: "string", enum: ["custom", "pocock-fix-bug", "wayfinder"] },
        notes: { type: "string", maxLength: 20_000 },
      },
      required: ["objective", "template"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

const delegateSchema = {
  type: "object",
  properties: {
    missionID: { type: "string" },
    taskKey: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" },
    title: { type: "string", minLength: 1, maxLength: 240 },
    brief: { type: "string", minLength: 1, maxLength: 20_000 },
    role: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" },
    blockedBy: { type: "array", maxItems: 24, items: { type: "string" } },
    targetSessionID: { type: "string", description: "Existing same-project root session to reuse; omit to create one." },
    delivery: { type: "string", enum: ["queue", "steer"], description: "queue is safe for a busy actor." },
  },
  required: ["taskKey", "title", "brief", "role"],
  additionalProperties: false,
}

const reportSchema = {
  type: "object",
  properties: {
    missionID: { type: "string" },
    taskKey: { type: "string" },
    outcome: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 20_000 },
    evidence: { type: "array", maxItems: 12, items: { type: "string", maxLength: 2_000 } },
    next: { type: "array", maxItems: 12, items: { type: "string", maxLength: 2_000 } },
    final: { type: "boolean", description: "Coordinator-only terminal mission report." },
  },
  required: ["outcome", "summary"],
  additionalProperties: false,
}

export function parseInspectInput(input: unknown): MissionInspectInput {
  const value = object(input)
  const missionID = optionalText(value.missionID, "missionID", 100)
  if (value.start === undefined) return { missionID }
  const start = object(value.start)
  const template = requiredText(start.template, "start.template", 40)
  if (!isTemplate(template)) throw new Error("start.template is unsupported")
  return {
    missionID,
    start: {
      objective: requiredText(start.objective, "start.objective", 20_000),
      template,
      notes: optionalText(start.notes, "start.notes", 20_000),
    },
  }
}

export function parseDelegateInput(input: unknown): MissionDelegateInput {
  const value = object(input)
  const taskKey = identifier(value.taskKey, "taskKey")
  const blockedBy = stringList(value.blockedBy, "blockedBy", 24, 64)
  return {
    missionID: optionalText(value.missionID, "missionID", 100),
    taskKey,
    title: requiredText(value.title, "title", 240),
    brief: requiredText(value.brief, "brief", 20_000),
    role: identifier(value.role, "role"),
    blockedBy,
    targetSessionID: optionalText(value.targetSessionID, "targetSessionID", 240),
    delivery: value.delivery === undefined ? "queue" : delivery(value.delivery),
  }
}

export function parseReportInput(input: unknown): MissionReportInput {
  const value = object(input)
  const outcome = requiredText(value.outcome, "outcome", 20)
  if (outcome !== "completed" && outcome !== "blocked" && outcome !== "failed") throw new Error("outcome is unsupported")
  return {
    missionID: optionalText(value.missionID, "missionID", 100),
    taskKey: optionalText(value.taskKey, "taskKey", 64),
    outcome,
    summary: requiredText(value.summary, "summary", 20_000),
    evidence: stringList(value.evidence, "evidence", 12, 2_000),
    next: stringList(value.next, "next", 12, 2_000),
    final: value.final === true,
  }
}

function textResult(value: unknown): { content: string } {
  return { content: JSON.stringify(value, null, 2) }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mission input must be an object")
  return value as Record<string, unknown>
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  return value.trim()
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, max)
}

function identifier(value: unknown, name: string): string {
  const result = requiredText(value, name, 64)
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(result)) throw new Error(`${name} must be a lowercase mission identifier`)
  return result
}

function stringList(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must contain at most ${maxItems} strings`)
  return value.map((item, index) => requiredText(item, `${name}[${index}]`, maxLength))
}

function delivery(value: unknown): "queue" | "steer" {
  if (value !== "queue" && value !== "steer") throw new Error("delivery must be queue or steer")
  return value
}

function isTemplate(value: string): value is MissionTemplateId {
  return value === "custom" || value === "pocock-fix-bug" || value === "wayfinder"
}

export default {
  id: "codenomad.missions",
  setup: setupMissionsPlugin,
}
