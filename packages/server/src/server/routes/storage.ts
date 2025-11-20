import { FastifyInstance } from "fastify"
import { z } from "zod"
import { InstanceStore } from "../../storage/instance-store"
import { EventBus } from "../../events/bus"
import { ModelPreferenceSchema } from "../../config/schema"
import type { InstanceData } from "../../api-types"
import { WorkspaceManager } from "../../workspaces/manager"

interface RouteDeps {
  instanceStore: InstanceStore
  eventBus: EventBus
  workspaceManager: WorkspaceManager
}

const InstanceDataSchema = z.object({
  messageHistory: z.array(z.string()).default([]),
  agentModelSelections: z.record(z.string(), ModelPreferenceSchema).default({}),
})

const EMPTY_INSTANCE_DATA: InstanceData = {
  messageHistory: [],
  agentModelSelections: {},
}

export function registerStorageRoutes(app: FastifyInstance, deps: RouteDeps) {
  const resolveStorageKey = (instanceId: string): string => {
    const workspace = deps.workspaceManager.get(instanceId)
    return workspace?.path ?? instanceId
  }

  app.get<{ Params: { id: string } }>("/api/storage/instances/:id", async (request, reply) => {
    try {
      const storageId = resolveStorageKey(request.params.id)
      const data = await deps.instanceStore.read(storageId)
      return data
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : "Failed to read instance data" }
    }
  })

  app.put<{ Params: { id: string } }>("/api/storage/instances/:id", async (request, reply) => {
    try {
      const body = InstanceDataSchema.parse(request.body ?? {})
      const storageId = resolveStorageKey(request.params.id)
      await deps.instanceStore.write(storageId, body)
      deps.eventBus.publish({ type: "instance.dataChanged", instanceId: request.params.id, data: body })
      reply.code(204)
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to save instance data" }
    }
  })

  app.delete<{ Params: { id: string } }>("/api/storage/instances/:id", async (request, reply) => {
    try {
      const storageId = resolveStorageKey(request.params.id)
      await deps.instanceStore.delete(storageId)
      deps.eventBus.publish({ type: "instance.dataChanged", instanceId: request.params.id, data: EMPTY_INSTANCE_DATA })
      reply.code(204)
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : "Failed to delete instance data" }
    }
  })
}
