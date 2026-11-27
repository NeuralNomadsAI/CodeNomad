import type { FastifyInstance, FastifyReply } from "fastify"
import { Service } from "@opencode/client/service"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import {
  automationIdSchema,
  projectSessionAutomation,
  type SessionAutomation,
  type SessionAutomationMutationResponse,
  type SessionAutomationsResponse,
} from "../../opencode/automation-contract"

export interface SessionAutomationsRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation" | "get" | "getServiceLocation">
}

const sessionIdSchema = z.string().min(4).max(512).regex(/^ses[A-Za-z0-9_-]*$/)
const READ_TIMEOUT_MS = 8_000
const MUTATION_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

async function readBoundedJson(response: Response, connection: ServiceConnection): Promise<unknown> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error("Automation response exceeds its read budget")
      chunks.push(value)
    }
    connection.assertCurrent()
    const raw = Buffer.concat(chunks).toString("utf8").trim()
    return raw ? JSON.parse(raw) : undefined
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function automationHeaders(connection: ServiceConnection, directory: string): Record<string, string> {
  return {
    ...Service.headers(connection.endpoint),
    "x-opencode-directory": encodeURIComponent(directory),
  }
}

function automationUrl(connection: ServiceConnection, pathname: string, directory: string, query?: Record<string, string>): URL {
  const url = new URL(pathname, connection.endpoint.url)
  url.searchParams.set("directory", directory)
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  }
  return url
}

async function readErrorMessage(response: Response, connection: ServiceConnection, fallback: string): Promise<string> {
  try {
    const body = await readBoundedJson(response, connection) as { message?: unknown; error?: unknown } | undefined
    if (typeof body?.message === "string" && body.message.trim()) return body.message.trim()
    if (typeof body?.error === "string" && body.error.trim()) return body.error.trim()
  } catch { /* ignore error body parse failures */ }
  return fallback
}

async function resolveOwnedSession(
  manager: SessionAutomationsRouteDeps["workspaceManager"],
  workspaceId: string,
  sessionID: string,
  signal: AbortSignal,
) {
  const workspace = manager.get(workspaceId)
  const base = manager.getServiceLocation(workspaceId)
  if (!workspace || !base) return { kind: "forbidden" as const }
  const connection = await manager.getSharedServiceConnection(workspaceId)
  if (!connection) return { kind: "unavailable" as const }
  const client = connection.client
  const current = () => {
    signal.throwIfAborted()
    connection.assertCurrent()
    if (manager.get(workspaceId) !== workspace || manager.getServiceLocation(workspaceId) !== base) {
      throw new Error("Automation owner changed")
    }
  }
  current()
  const session = await client.session.get({ sessionID }, { signal }).catch(() => undefined)
  current()
  if (!session) return { kind: "not-found" as const }
  const location = readLocationRef(session.location)
  if (!await manager.ownsLocation(workspaceId, location, client, { signal })) return { kind: "forbidden" as const }
  const revalidate = async () => {
    current()
    const latest = await client.session.get({ sessionID }, { signal })
    current()
    if (!sameLocation(location, readLocationRef(latest.location))
      || latest.projectID !== session.projectID
      || !await manager.ownsLocation(workspaceId, latest.location, client, { signal })) {
      throw new Error("Automation session moved")
    }
    current()
  }
  return { kind: "ok" as const, connection, location, revalidate }
}

/**
 * Reads and controls a Session's native `/automation` items in the Session's own
 * Location, after verifying that both the Session and the target automation belong
 * to the workspace and Session.
 */
export function registerSessionAutomationsRoutes(app: FastifyInstance, deps: SessionAutomationsRouteDeps): void {
  app.get<{ Params: { id: string; sessionId: string } }>("/api/workspaces/:id/sessions/:sessionId/automations", async (request, reply) => {
    reply.header("cache-control", "no-store")
    const parsedSession = sessionIdSchema.safeParse(request.params.sessionId)
    if (!parsedSession.success) return reply.code(400).send({ error: "Invalid session" })
    const sessionID = parsedSession.data
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
      const owned = await resolveOwnedSession(deps.workspaceManager, request.params.id, sessionID, signal)
      if (owned.kind === "forbidden") return reply.code(403).send({ error: "Session does not belong to workspace" })
      if (owned.kind === "not-found") return reply.code(404).send({ error: "Session not found" })
      if (owned.kind === "unavailable") return { status: "unavailable" } satisfies SessionAutomationsResponse

      const url = automationUrl(owned.connection, "/api/experimental/automation", owned.location.directory, { sessionID })
      const response = await owned.connection.fetch(url, {
        method: "GET",
        headers: automationHeaders(owned.connection, owned.location.directory),
        signal,
        redirect: "error",
      })
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        await response.body?.cancel()
        return { status: "unsupported" } satisfies SessionAutomationsResponse
      }
      if (!response.ok) {
        await response.body?.cancel()
        return { status: "unavailable" } satisfies SessionAutomationsResponse
      }
      const payload = await readBoundedJson(response, owned.connection) as { data?: unknown } | undefined
      await owned.revalidate()
      if (!payload || !Array.isArray(payload.data)) {
        return { status: "unavailable" } satisfies SessionAutomationsResponse
      }
      const automations: SessionAutomation[] = []
      for (const raw of payload.data) {
        const projected = projectSessionAutomation(raw)
        if (!projected) return { status: "unavailable" } satisfies SessionAutomationsResponse
        if (projected.sessionID !== sessionID) continue
        automations.push(projected.automation)
      }
      return { status: "ok", automations } satisfies SessionAutomationsResponse
    } catch {
      return { status: "unavailable" } satisfies SessionAutomationsResponse
    } finally {
      reply.raw.removeListener("close", abort)
    }
  })

  const mutate = async (
    workspaceId: string,
    rawSessionId: string,
    rawAutomationId: string,
    action: "pause" | "resume" | "delete",
    reply: FastifyReply,
  ) => {
    reply.header("cache-control", "no-store")
    const parsedSession = sessionIdSchema.safeParse(rawSessionId)
    if (!parsedSession.success) return reply.code(400).send({ status: "error", error: "Invalid session" } satisfies SessionAutomationMutationResponse)
    const parsedAutomation = automationIdSchema.safeParse(rawAutomationId)
    if (!parsedAutomation.success) return reply.code(400).send({ status: "error", error: "Invalid automation" } satisfies SessionAutomationMutationResponse)
    const sessionID = parsedSession.data
    const automationID = parsedAutomation.data
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MUTATION_TIMEOUT_MS)])
      const owned = await resolveOwnedSession(deps.workspaceManager, workspaceId, sessionID, signal)
      if (owned.kind === "forbidden") return reply.code(403).send({ status: "error", error: "Session does not belong to workspace" } satisfies SessionAutomationMutationResponse)
      if (owned.kind === "not-found") return reply.code(404).send({ status: "error", error: "Session not found" } satisfies SessionAutomationMutationResponse)
      if (owned.kind === "unavailable") return reply.code(503).send({ status: "error", error: "OpenCode is unavailable" } satisfies SessionAutomationMutationResponse)

      const headers = automationHeaders(owned.connection, owned.location.directory)
      const encodedId = encodeURIComponent(automationID)
      const inspectResponse = await owned.connection.fetch(
        automationUrl(owned.connection, `/api/experimental/automation/${encodedId}`, owned.location.directory),
        { method: "GET", headers, signal, redirect: "error" },
      )
      if (inspectResponse.status === 404) {
        await inspectResponse.body?.cancel()
        return reply.code(404).send({ status: "error", error: "Automation not found" } satisfies SessionAutomationMutationResponse)
      }
      if (!inspectResponse.ok) {
        const message = await readErrorMessage(inspectResponse, owned.connection, "Could not inspect the automation")
        return reply.code(502).send({ status: "error", error: message } satisfies SessionAutomationMutationResponse)
      }
      const inspectBody = await readBoundedJson(inspectResponse, owned.connection) as { data?: unknown } | undefined
      const current = projectSessionAutomation(inspectBody?.data)
      if (!current) {
        return reply.code(502).send({ status: "error", error: "Automation response was invalid" } satisfies SessionAutomationMutationResponse)
      }
      if (current.sessionID !== sessionID) {
        return reply.code(403).send({ status: "error", error: "Automation does not belong to session" } satisfies SessionAutomationMutationResponse)
      }
      await owned.revalidate()

      const targetPath = action === "delete"
        ? `/api/experimental/automation/${encodedId}`
        : `/api/experimental/automation/${encodedId}/${action}`
      const method = action === "delete" ? "DELETE" : "POST"
      const response = await owned.connection.fetch(
        automationUrl(owned.connection, targetPath, owned.location.directory),
        { method, headers, signal, redirect: "error" },
      )
      if (response.status === 404) {
        await response.body?.cancel()
        return reply.code(404).send({ status: "error", error: "Automation not found" } satisfies SessionAutomationMutationResponse)
      }
      if (!response.ok) {
        const message = await readErrorMessage(response, owned.connection, "Could not update the automation")
        return reply.code(502).send({ status: "error", error: message } satisfies SessionAutomationMutationResponse)
      }
      if (action === "delete") {
        await response.body?.cancel()
        return { status: "ok" } satisfies SessionAutomationMutationResponse
      }
      const body = await readBoundedJson(response, owned.connection) as { data?: unknown } | undefined
      const updated = projectSessionAutomation(body?.data)
      return updated
        ? ({ status: "ok", automation: updated.automation } satisfies SessionAutomationMutationResponse)
        : ({ status: "ok" } satisfies SessionAutomationMutationResponse)
    } catch {
      return reply.code(502).send({ status: "error", error: "Could not update the automation" } satisfies SessionAutomationMutationResponse)
    } finally {
      reply.raw.removeListener("close", abort)
    }
  }

  app.post<{ Params: { id: string; sessionId: string; automationId: string } }>(
    "/api/workspaces/:id/sessions/:sessionId/automations/:automationId/pause",
    async (request, reply) => mutate(request.params.id, request.params.sessionId, request.params.automationId, "pause", reply),
  )

  app.post<{ Params: { id: string; sessionId: string; automationId: string } }>(
    "/api/workspaces/:id/sessions/:sessionId/automations/:automationId/resume",
    async (request, reply) => mutate(request.params.id, request.params.sessionId, request.params.automationId, "resume", reply),
  )

  app.delete<{ Params: { id: string; sessionId: string; automationId: string } }>(
    "/api/workspaces/:id/sessions/:sessionId/automations/:automationId",
    async (request, reply) => mutate(request.params.id, request.params.sessionId, request.params.automationId, "delete", reply),
  )
}
