import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkflowManager } from "../../workflows/manager"
import { WorkflowRunError } from "../../workflows/manager"

interface RouteDeps {
  workflowManager: WorkflowManager
}

const ModelSchema = z.object({
  providerID: z.string().trim().min(1).max(200),
  modelID: z.string().trim().min(1).max(200),
})

const StageSchema = z.object({
  id: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(20_000),
  agent: z.string().trim().min(1).max(200).optional(),
  model: ModelSchema.optional(),
  requiresApproval: z.boolean().optional(),
})

const CreateObjectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  initiatorSessionId: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(50_000),
  stages: z.array(StageSchema).min(1).max(12),
})

const requireUniqueStageIds = (value: { stages: Array<{ id: string }> }, ctx: z.RefinementCtx) => {
  const ids = new Set<string>()
  value.stages.forEach((stage, index) => {
    if (ids.has(stage.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Stage IDs must be unique", path: ["stages", index, "id"] })
    }
    ids.add(stage.id)
  })
}

const CreateSchema = CreateObjectSchema.superRefine(requireUniqueStageIds)

const RunIdSchema = z.string().uuid()
const ListSchema = z.object({ workspaceId: z.string().trim().min(1).max(200).optional() })
const PluginCreateSchema = CreateObjectSchema.omit({ workspaceId: true }).superRefine(requireUniqueStageIds)

export function registerWorkflowRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/workflow-runs", async (request) => {
    return { runs: await deps.workflowManager.list(request.params.id) }
  })

  app.post<{ Params: { id: string } }>("/workspaces/:id/plugin/workflow-runs", async (request, reply) => {
    const parsed = PluginCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow request", issues: parsed.error.flatten() }
    }
    try {
      const run = await deps.workflowManager.start({ ...parsed.data, workspaceId: request.params.id })
      reply.code(202)
      return run
    } catch (error) {
      if (error instanceof WorkflowRunError) {
        reply.code(error.statusCode)
        return { error: error.message }
      }
      throw error
    }
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
      if (!run || run.workspaceId !== request.params.id) {
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
      const existing = await deps.workflowManager.get(parsed.data, request.params.id)
      if (!existing || existing.workspaceId !== request.params.id) {
        reply.code(404)
        return { error: "Workflow run not found" }
      }
      try {
        return await deps.workflowManager.cancel(parsed.data)
      } catch (error) {
        if (error instanceof WorkflowRunError) {
          reply.code(error.statusCode)
          return { error: error.message }
        }
        throw error
      }
    },
  )

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
      const run = await deps.workflowManager.start(parsed.data)
      reply.code(202)
      return run
    } catch (error) {
      if (error instanceof WorkflowRunError) {
        reply.code(error.statusCode)
        return { error: error.message }
      }
      throw error
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
      if (error instanceof WorkflowRunError) {
        reply.code(error.statusCode)
        return { error: error.message }
      }
      throw error
    }
  })

  app.post<{ Params: { runId: string } }>("/api/workflow-runs/:runId/approve", async (request, reply) => {
    const parsed = RunIdSchema.safeParse(request.params.runId)
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid workflow run ID" }
    }
    try {
      const run = await deps.workflowManager.approve(parsed.data)
      if (!run) {
        reply.code(404)
        return { error: "Workflow run not found" }
      }
      return run
    } catch (error) {
      if (error instanceof WorkflowRunError) {
        reply.code(error.statusCode)
        return { error: error.message }
      }
      throw error
    }
  })
}
