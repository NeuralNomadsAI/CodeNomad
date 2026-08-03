import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkflowDefinitionRunCreateRequest, WorkflowRun } from "../../api-types"
import { WORKFLOW_DEFINITION_REVISION_LIMIT, WORKFLOW_LIMITS } from "../../workflows/definition-schema"
import { WorkflowDefinitionStoreError } from "../../workflows/definition-store"
import type { WorkflowManager } from "../../workflows/manager"
import { WorkflowRunError } from "../../workflows/manager"

type WorkflowManagerWithLatestStart = WorkflowManager & {
  startLatest?: (input: WorkflowDefinitionRunCreateRequest) => Promise<WorkflowRun>
}

interface RouteDeps {
  workflowManager: WorkflowManagerWithLatestStart
}

const DefinitionRevisionSchema = z.number().int().min(1).max(WORKFLOW_DEFINITION_REVISION_LIMIT)

const ModelSchema = z.object({
  providerID: z.string().trim().min(1).max(200),
  modelID: z.string().trim().min(1).max(200),
}).strict()

const StageSchema = z.object({
  id: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(20_000),
  agent: z.string().trim().min(1).max(200).optional(),
  model: ModelSchema.optional(),
  requiresApproval: z.boolean().optional(),
}).strict()

const CreateObjectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  initiatorSessionId: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(50_000),
  stages: z.array(StageSchema).min(1).max(12),
}).strict()

const WorktreePolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("current") }).strict(),
  z.object({ mode: z.literal("existing"), slug: z.string().trim().min(1).max(200) }).strict(),
  z.object({ mode: z.literal("new"), slug: z.string().trim().min(1).max(200) }).strict(),
])

const DefinitionStartObjectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  initiatorSessionId: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(50_000).optional(),
  definitionId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  definitionRevision: DefinitionRevisionSchema.optional(),
  inputs: z.record(z.unknown()).superRefine(validateBoundedJson).optional(),
  worktree: WorktreePolicySchema.optional(),
}).strict()

const requireUniqueStageIds = (value: { stages: Array<{ id: string }> }, ctx: z.RefinementCtx) => {
  const ids = new Set<string>()
  value.stages.forEach((stage, index) => {
    if (ids.has(stage.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Stage IDs must be unique", path: ["stages", index, "id"] })
    }
    ids.add(stage.id)
  })
}

const LegacyCreateSchema = CreateObjectSchema.superRefine(requireUniqueStageIds)
const CreateSchema = z.union([LegacyCreateSchema, DefinitionStartObjectSchema])

const RunIdSchema = z.string().uuid()
const ListSchema = z.object({ workspaceId: z.string().trim().min(1).max(200).optional() })
const PluginDefinitionStartSchema = z.object({
  initiatorSessionId: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(50_000).optional(),
  inputs: z.record(z.unknown()).superRefine(validateBoundedJson).optional(),
}).strict()
const DefinitionIdSchema = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
const DefinitionRevisionQuerySchema = z.object({
  revision: z.coerce.number().int().min(1).max(WORKFLOW_DEFINITION_REVISION_LIMIT).optional(),
})
const DefinitionSourceSchema = z.object({
  source: z.string().optional(),
  definition: z.unknown().optional(),
}).strict().superRefine((value, ctx) => {
  const supplied = Number(value.source !== undefined) + Number(Object.prototype.hasOwnProperty.call(value, "definition"))
  if (supplied !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Supply exactly one of source or definition" })
})
const DefinitionUpdateSchema = z.object({
  expectedRevision: DefinitionRevisionSchema,
  source: z.string().optional(),
  definition: z.unknown().optional(),
}).strict().superRefine((value, ctx) => {
  const supplied = Number(value.source !== undefined) + Number(Object.prototype.hasOwnProperty.call(value, "definition"))
  if (supplied !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Supply exactly one of source or definition" })
})
const DeleteDefinitionQuerySchema = z.object({
  expectedRevision: z.coerce.number().int().min(1).max(WORKFLOW_DEFINITION_REVISION_LIMIT),
})
const ResumeSchema = z.object({ confirmRecovery: z.boolean().optional() }).strict()
const ApprovalSchema = z.object({ expectedStepId: z.string().trim().min(1).max(100) }).strict()
const AnswerSchema = z.object({ executionNodeId: z.string().uuid(), answer: z.unknown() }).strict().superRefine((value, ctx) => {
  if (!Object.prototype.hasOwnProperty.call(value, "answer")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "answer is required" })
  else validateBoundedJson(value.answer, ctx)
})

const JSON_VALUE_COUNT_LIMIT = 50_000

function validateBoundedJson(value: unknown, ctx: z.RefinementCtx): void {
  const issue = inspectBoundedJson(value)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
}

function inspectBoundedJson(input: unknown): string | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  const seen = new WeakSet<object>()
  let count = 0
  let bytes = 0

  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++count > JSON_VALUE_COUNT_LIMIT) return "JSON value contains too many values"
    if (depth > WORKFLOW_LIMITS.valueDepth) return "JSON value is too deeply nested"
    if (value === null) bytes += 4
    else if (typeof value === "string") bytes += Buffer.byteLength(JSON.stringify(value), "utf8")
    else if (typeof value === "boolean") bytes += value ? 4 : 5
    else if (typeof value === "number" && Number.isFinite(value)) bytes += JSON.stringify(value).length
    else if (value && typeof value === "object") {
      if (seen.has(value)) return "JSON value must not contain cycles or aliases"
      seen.add(value)
      if (Array.isArray(value)) {
        const keys = Object.keys(value)
        if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
          return "JSON value must contain only plain arrays"
        }
        bytes += 2 + Math.max(0, value.length - 1)
        for (let index = value.length - 1; index >= 0; index--) {
          pending.push({ value: value[index], depth: depth + 1 })
        }
      } else {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return "JSON value must contain only plain objects"
        const keys = Object.keys(value)
        if (Reflect.ownKeys(value).length !== keys.length) return "JSON value must contain only plain objects"
        bytes += 2 + Math.max(0, keys.length - 1)
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return "JSON value must contain only plain objects"
          bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1
          pending.push({ value: descriptor.value, depth: depth + 1 })
        }
      }
    } else return "JSON value must contain only JSON values"

    if (bytes > WORKFLOW_LIMITS.sourceBytes) return "JSON value is too large"
  }
}

const definitionSource = (value: { source?: string; definition?: unknown }) => value.source ?? value.definition
const belongsToWorkspace = (run: { workspaceId: string; worktreeSelection?: { sourceWorkspaceId: string } }, workspaceId: string) =>
  run.workspaceId === workspaceId || run.worktreeSelection?.sourceWorkspaceId === workspaceId

const handleWorkflowError = (error: unknown, reply: { code(statusCode: number): unknown }) => {
  if (error instanceof WorkflowRunError || error instanceof WorkflowDefinitionStoreError) {
    reply.code(error.statusCode)
    return { error: error.message }
  }
  if (error instanceof z.ZodError) {
    reply.code(400)
    return { error: "Invalid workflow definition", issues: error.flatten() }
  }
  throw error
}

async function startLatestDefinition(
  manager: WorkflowManagerWithLatestStart,
  input: WorkflowDefinitionRunCreateRequest,
): Promise<WorkflowRun> {
  if (!manager.startLatest) {
    throw new WorkflowRunError("Atomic saved workflow start is unavailable", 501)
  }
  return manager.startLatest(input)
}

export function registerWorkflowRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/workflow-definitions", async () => {
    return { definitions: await deps.workflowManager.listDefinitions() }
  })

  app.post<{ Params: { id: string } }>("/workspaces/:id/plugin/workflow-definitions", async (request, reply) => {
    const parsed = DefinitionSourceSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow definition request", issues: parsed.error.flatten() }
    }
    try {
      const record = await deps.workflowManager.createDefinition(definitionSource(parsed.data))
      reply.code(201)
      return record
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.get<{ Params: { id: string; definitionId: string } }>(
    "/workspaces/:id/plugin/workflow-definitions/:definitionId",
    async (request, reply) => {
      const id = DefinitionIdSchema.safeParse(request.params.definitionId)
      if (!id.success) {
        reply.code(400)
        return { error: "Invalid workflow definition request" }
      }
      const definition = await deps.workflowManager.getDefinition(id.data)
      if (!definition) {
        reply.code(404)
        return { error: "Workflow definition not found" }
      }
      return definition
    },
  )

  app.put<{ Params: { id: string; definitionId: string } }>(
    "/workspaces/:id/plugin/workflow-definitions/:definitionId",
    async (request, reply) => {
      const id = DefinitionIdSchema.safeParse(request.params.definitionId)
      const body = DefinitionUpdateSchema.safeParse(request.body)
      if (!id.success || !body.success) {
        reply.code(400)
        return { error: "Invalid workflow definition request" }
      }
      try {
        return await deps.workflowManager.updateDefinition(id.data, body.data.expectedRevision, definitionSource(body.data))
      } catch (error) {
        return handleWorkflowError(error, reply)
      }
    },
  )

  app.post<{ Params: { id: string; definitionId: string } }>(
    "/workspaces/:id/plugin/workflow-definitions/:definitionId/start",
    async (request, reply) => {
      const id = DefinitionIdSchema.safeParse(request.params.definitionId)
      const body = PluginDefinitionStartSchema.safeParse(request.body)
      if (!id.success || !body.success) {
        reply.code(400)
        return { error: "Invalid workflow request" }
      }
      try {
        const run = await deps.workflowManager.start({
          ...body.data,
          workspaceId: request.params.id,
          definitionId: id.data,
        })
        reply.code(202)
        return run
      } catch (error) {
        return handleWorkflowError(error, reply)
      }
    },
  )

  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/workflow-runs", async (request) => {
    return { runs: await deps.workflowManager.list(request.params.id) }
  })

  app.get<{ Params: { id: string; runId: string } }>(
    "/workspaces/:id/plugin/workflow-runs/:runId",
    async (request, reply) => {
      const parsed = RunIdSchema.safeParse(request.params.runId)
      if (!parsed.success) {
        reply.code(400)
        return { error: "Invalid workflow run ID" }
      }
      const run = await deps.workflowManager.get(parsed.data, request.params.id)
      if (!run || !belongsToWorkspace(run, request.params.id)) {
        reply.code(404)
        return { error: "Workflow run not found" }
      }
      return run
    },
  )

  app.post<{ Params: { id: string; runId: string } }>(
    "/workspaces/:id/plugin/workflow-runs/:runId/cancel",
    async (request, reply) => {
      const parsed = RunIdSchema.safeParse(request.params.runId)
      if (!parsed.success) {
        reply.code(400)
        return { error: "Invalid workflow run ID" }
      }
      try {
        const run = await deps.workflowManager.cancelOwned(parsed.data, request.params.id)
        if (!run) {
          reply.code(404)
          return { error: "Workflow run not found" }
        }
        return run
      } catch (error) {
        return handleWorkflowError(error, reply)
      }
    },
  )

  app.post("/api/workflow-definitions/validate", async (request, reply) => {
    const parsed = DefinitionSourceSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return { valid: false, issues: parsed.error.issues }
    }
    const result = deps.workflowManager.validateDefinition(definitionSource(parsed.data))
    if (!result.valid) reply.code(400)
    return result
  })

  app.get("/api/workflow-definitions", async () => ({ definitions: await deps.workflowManager.listDefinitions() }))

  app.post("/api/workflow-definitions", async (request, reply) => {
    const parsed = DefinitionSourceSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow definition request", issues: parsed.error.flatten() }
    }
    try {
      const record = await deps.workflowManager.createDefinition(definitionSource(parsed.data))
      reply.code(201)
      return record
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.get<{ Params: { definitionId: string }; Querystring: { revision?: string } }>(
    "/api/workflow-definitions/:definitionId",
    async (request, reply) => {
      const id = DefinitionIdSchema.safeParse(request.params.definitionId)
      const query = DefinitionRevisionQuerySchema.safeParse(request.query)
      if (!id.success || !query.success) {
        reply.code(400)
        return { error: "Invalid workflow definition request" }
      }
      const definition = await deps.workflowManager.getDefinition(id.data, query.data.revision)
      if (!definition) {
        reply.code(404)
        return { error: "Workflow definition not found" }
      }
      return definition
    },
  )

  app.put<{ Params: { definitionId: string } }>("/api/workflow-definitions/:definitionId", async (request, reply) => {
    const id = DefinitionIdSchema.safeParse(request.params.definitionId)
    const body = DefinitionUpdateSchema.safeParse(request.body)
    if (!id.success || !body.success) {
      reply.code(400)
      return { error: "Invalid workflow definition request" }
    }
    try {
      return await deps.workflowManager.updateDefinition(id.data, body.data.expectedRevision, definitionSource(body.data))
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.delete<{ Params: { definitionId: string }; Querystring: { expectedRevision?: string } }>(
    "/api/workflow-definitions/:definitionId",
    async (request, reply) => {
      const id = DefinitionIdSchema.safeParse(request.params.definitionId)
      const query = DeleteDefinitionQuerySchema.safeParse(request.query)
      if (!id.success || !query.success) {
        reply.code(400)
        return { error: "Invalid workflow definition request" }
      }
      try {
        const deleted = await deps.workflowManager.deleteDefinition(id.data, query.data.expectedRevision)
        if (!deleted) {
          reply.code(404)
          return { error: "Workflow definition not found" }
        }
        reply.code(204)
        return undefined
      } catch (error) {
        return handleWorkflowError(error, reply)
      }
    },
  )

  app.post<{ Params: { definitionId: string } }>("/api/workflow-definitions/:definitionId/start", async (request, reply) => {
    const id = DefinitionIdSchema.safeParse(request.params.definitionId)
    const body = DefinitionStartObjectSchema.omit({ definitionId: true }).safeParse(request.body)
    if (!id.success || !body.success) {
      reply.code(400)
      return { error: "Invalid workflow request" }
    }
    try {
      const run = await startLatestDefinition(deps.workflowManager, { ...body.data, definitionId: id.data })
      reply.code(202)
      return run
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.get("/api/workflow-runs", async (request, reply) => {
    const parsed = ListSchema.safeParse(request.query)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow query" }
    }
    return { runs: await deps.workflowManager.list(parsed.data.workspaceId) }
  })

  app.post("/api/workflow-runs", async (request, reply) => {
    const parsed = CreateSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow request", issues: parsed.error.flatten() }
    }

    try {
      const run = "stages" in parsed.data
        ? await deps.workflowManager.start(parsed.data)
        : await startLatestDefinition(deps.workflowManager, parsed.data)
      reply.code(202)
      return run
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.get<{ Params: { runId: string } }>("/api/workflow-runs/:runId", async (request, reply) => {
    const parsed = RunIdSchema.safeParse(request.params.runId)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow run ID" }
    }
    const run = await deps.workflowManager.get(parsed.data)
    if (!run) {
      reply.code(404)
      return { error: "Workflow run not found" }
    }
    return run
  })

  app.post<{ Params: { runId: string } }>("/api/workflow-runs/:runId/cancel", async (request, reply) => {
    const parsed = RunIdSchema.safeParse(request.params.runId)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow run ID" }
    }
    try {
      const run = await deps.workflowManager.cancel(parsed.data)
      if (!run) {
        reply.code(404)
        return { error: "Workflow run not found" }
      }
      return run
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.post<{ Params: { runId: string } }>("/api/workflow-runs/:runId/approve", async (request, reply) => {
    const id = RunIdSchema.safeParse(request.params.runId)
    const body = ApprovalSchema.safeParse(request.body)
    if (!id.success || !body.success) {
      reply.code(400)
      return { error: "Invalid workflow approval request" }
    }
    try {
      const run = await deps.workflowManager.approve(id.data, body.data.expectedStepId)
      if (!run) {
        reply.code(404)
        return { error: "Workflow run not found" }
      }
      return run
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.post<{ Params: { runId: string } }>("/api/workflow-runs/:runId/pause", async (request, reply) => {
    const parsed = RunIdSchema.safeParse(request.params.runId)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow run ID" }
    }
    try {
      const run = await deps.workflowManager.pause(parsed.data)
      if (!run) { reply.code(404); return { error: "Workflow run not found" } }
      return run
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.post<{ Params: { runId: string } }>("/api/workflow-runs/:runId/resume", async (request, reply) => {
    const id = RunIdSchema.safeParse(request.params.runId)
    const body = ResumeSchema.safeParse(request.body ?? {})
    if (!id.success || !body.success) {
      reply.code(400)
      return { error: "Invalid workflow resume request" }
    }
    try {
      const run = await deps.workflowManager.resume(id.data, body.data.confirmRecovery)
      if (!run) { reply.code(404); return { error: "Workflow run not found" } }
      return run
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })

  app.post<{ Params: { runId: string } }>("/api/workflow-runs/:runId/answer", async (request, reply) => {
    const id = RunIdSchema.safeParse(request.params.runId)
    const body = AnswerSchema.safeParse(request.body)
    if (!id.success || !body.success) {
      reply.code(400)
      return { error: "Invalid workflow gate answer" }
    }
    try {
      const run = await deps.workflowManager.answer(id.data, body.data.executionNodeId, body.data.answer)
      if (!run) { reply.code(404); return { error: "Workflow run not found" } }
      return run
    } catch (error) {
      return handleWorkflowError(error, reply)
    }
  })
}
