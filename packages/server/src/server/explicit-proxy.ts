import type { FastifyReply, FastifyRequest } from "fastify"
import { isInvalidRequestError, isSessionNotFoundError } from "@opencode/client"
import type { InstanceProxyWorkspaceManager } from "./http-server"
import { WorkspaceCapabilityError, type ServerCapability } from "../opencode/servers/capabilities"
import { LOCATION_CONTEXT_HEADER, readLocationContext, readLocationRef } from "../opencode/compatibility/location"
import { decodeMessageListCursor, decodeSessionListScope } from "../opencode/compatibility/proxy-locations"
import { deferToolMedia, wantsDeferredMedia } from "../opencode/session-media"
import { forwardRuntimeRequest } from "../opencode/compatibility/proxy"
import { validatePromptAttachmentBudget } from "./prompt-attachment-budget"
import { readExplicitForm } from "./explicit-form-verification"
import { FORM_VERIFICATION_TIMEOUT_MS } from "../opencode/form-verification-policy"

/** Closed E1 product operations; adding upstream APIs requires a policy review. */
function operation(method: string, path: string): ServerCapability | undefined {
  if (method === "GET" && /^\/api\/(?:agent(?:\/[^/]+)?|command|location|mcp|model(?:\/default)?|provider|reference|skill|websearch\/provider)$/.test(path)) return "chat"
  if (method === "GET" && /^\/api\/session(?:\/active)?$/.test(path)) return "sessions"
  if (method === "POST" && path === "/api/session") return "sessions"
  if (method === "GET" && /^\/api\/session\/[^/]+(?:\/message(?:\/[^/]+)?|\/inbox)?$/.test(path)) return "sessions"
  if (["PATCH", "DELETE"].includes(method) && /^\/api\/session\/[^/]+$/.test(path)) return "sessions"
  if (["PATCH", "DELETE"].includes(method) && /^\/api\/session\/[^/]+\/inbox\/[^/]+$/.test(path)) return "chat"
  if (method === "POST" && /^\/api\/session\/[^/]+\/(?:agent|model|prompt|command|shell|compact|interrupt|fork|generate)$/.test(path)) return "chat"
  if ((method === "GET" && /^\/api\/experimental\/session\/[^/]+\/instructions\/entries$/.test(path))
    || (["PUT", "DELETE"].includes(method) && /^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/[^/]+$/.test(path))) return "chat"
  if (method === "POST" && /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path)) return "permissions"
  if ((method === "POST" && /^\/api\/session\/[^/]+\/form\/[^/]+\/reply$/.test(path))
    || (method === "GET" && /^\/api\/session\/[^/]+\/form\/[^/]+$/.test(path))
    || (method === "DELETE" && /^\/api\/session\/[^/]+\/form\/[^/]+$/.test(path))) return "questions"
  // prototype-1236: branch read and the background-shell panel's operations. Never credentials or config.
  if (method === "GET" && path === "/api/vcs") return "git"
  // Runtime MCP connect/disconnect of servers the remote configuration already declares (no config write).
  if (method === "POST" && /^\/api\/experimental\/mcp\/[^/]+\/(?:connect|disconnect)$/.test(path)) return "plugins"
  if ((method === "GET" && /^\/api\/shell(?:\/[^/]+(?:\/output)?)?$/.test(path))
    || (method === "DELETE" && /^\/api\/shell\/[^/]+$/.test(path))) return "backgroundShells"
  return undefined
}

function deferredCapability(path: string): ServerCapability {
  if (/\/fs\//.test(path)) return "files"
  if (/\/vcs(?:\/|$)/.test(path)) return "git"
  if (/\/diff$/.test(path)) return "conversationDiffs"
  if (/\/move$|\/worktree(?:\/|$)/.test(path)) return "worktrees"
  if (/\/pty(?:\/|$)/.test(path)) return "terminal"
  if (/^\/api\/shell(?:\/|$)/.test(path)) return "backgroundShells"
  if (/\/environment$/.test(path)) return "sessionEnvironment"
  if (/\/(?:form|permission\/request)$/.test(path)) return "pendingRecovery"
  if (/\/rpc\//.test(path)) return "historyEnrichment"
  return "executionSettings"
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)

/** No host adapters, global clients, environment snapshots, receipts or account activation. */
export async function proxyExplicitWorkspaceRequest(args: {
  request: FastifyRequest; reply: FastifyReply; workspaceManager: InstanceProxyWorkspaceManager
  workspaceId: string; workspace: NonNullable<ReturnType<InstanceProxyWorkspaceManager["get"]>>
  pathname: string; signal: AbortSignal; wait<T>(pending: Promise<T>): Promise<T>
}) {
  const { request, reply, workspaceManager: manager, workspaceId: id, workspace, wait } = args
  const path = args.pathname.replace(/\/+$/, ""), method = request.method
  const formRead = method === "GET" && path.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)$/)
  // A single deadline includes admission, acquisition, profile and all three reads.
  const formExpiresAt = formRead ? performance.now() + FORM_VERIFICATION_TIMEOUT_MS : 0
  const formDeadline = formRead ? AbortSignal.timeout(FORM_VERIFICATION_TIMEOUT_MS) : undefined
  const capability = operation(method, path)
  let workspaceSignal: AbortSignal
  try {
    // A URL can select an operation, never a caller-supplied capability name.
    if (!capability) {
      const denied = deferredCapability(path)
      manager.requireWorkspaceCapability?.(id, denied)
      throw new WorkspaceCapabilityError(denied, { code: "deferred" })
    }
    if (!manager.requireWorkspaceCapability) throw new WorkspaceCapabilityError(capability, { code: "contractUnverified" })
    workspaceSignal = manager.requireWorkspaceCapability(id, capability)
  } catch (error) {
    if (error instanceof WorkspaceCapabilityError) return reply.code(403).send({ error: error.code, capability: error.capability, reason: error.reason })
    throw error
  }
  const signal = AbortSignal.any([args.signal, workspaceSignal])
  signal.throwIfAborted()

  const directory = workspace.binding!.directory
  const query = new URLSearchParams((request.raw.url ?? "").split("?").slice(1).join("?"))
  const locations: unknown[] = []
  const sessionMatch = path.match(/^\/api\/(?:experimental\/)?session\/([^/]+)(?:\/|$)/)
  const sessionId = sessionMatch && sessionMatch[1] !== "active" ? sessionMatch[1] : undefined
  const globalForm = sessionId === "global" && /\/form\//.test(path)
  let body = request.body
  const expectedGeneration = request.headers["x-codenomad-connection-generation"]
  try {
    // Malformed escapes and multiply encoded route segments have no native authority.
    if (/%|\\/.test(path) || path.split("/").some(value => value === "." || value === "..")) throw new Error()
    const rawHeaders = request.raw.rawHeaders
    const counts = new Map<string, number>()
    for (let i = 0; i < rawHeaders.length; i += 2) counts.set(rawHeaders[i].toLowerCase(), (counts.get(rawHeaders[i].toLowerCase()) ?? 0) + 1)
    for (const name of [LOCATION_CONTEXT_HEADER, "x-opencode-directory", "x-opencode-workspace", "x-codenomad-connection-generation"]) if ((counts.get(name) ?? 0) > 1) throw new Error()
    if (expectedGeneration !== undefined && (typeof expectedGeneration !== "string" || !/^[1-9]\d*$/.test(expectedGeneration)
      || !Number.isSafeInteger(Number(expectedGeneration)))) throw new Error()
    if (request.headers["x-opencode-workspace"] !== undefined || request.headers["x-codenomad-human-answer"] !== undefined
      || request.headers["x-codenomad-pending-reconciliation"] !== undefined) throw new Error()
    const context = readLocationContext(request.headers[LOCATION_CONTEXT_HEADER])
    if (context) locations.push(context.directory)
    const header = request.headers["x-opencode-directory"]
    if (header !== undefined) {
      if (!globalForm || typeof header !== "string") throw new Error()
      locations.push(decodeURIComponent(header))
    }
    for (const key of query.keys()) {
      if (query.getAll(key).length !== 1) throw new Error()
      if (["directory", "location[directory]"].includes(key)) locations.push(query.get(key))
      else if (!(method === "GET" && ["cursor", "limit", "order", "search", "parentID", "archived"].includes(key))
        && !(method === "POST" && /\/interrupt$/.test(path) && key === "resume")
        && !(method === "DELETE" && /\/form\/[^/]+$/.test(path) && key === "message")) throw new Error()
    }
    if (query.has("directory") && query.has("location[directory]")) throw new Error()
    if (body !== undefined) {
      if (!object(body) || request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error()
      const input = body
      if (["workspace", "workspaceID", "cwd", "project", "projectID", "subpath"].some(key => key in input)) throw new Error()
      if ("directory" in body) locations.push(body.directory)
      if ("location" in body) {
        if (!object(body.location) || Object.keys(body.location).some(key => key !== "directory")) throw new Error()
        locations.push(body.location.directory)
      }
      if ("directory" in body && "location" in body) throw new Error()
      if (method === "POST" && path === "/api/session" && "parentID" in body) throw new Error()
      if ("files" in body && (!Array.isArray(body.files) || body.files.some(file => !object(file) || typeof file.uri !== "string" || !file.uri.startsWith("data:")))) {
        return reply.code(403).send({ error: "explicit_capability_unavailable", capability: "files", reason: { code: "deferred" } })
      }
    }
    if (locations.some(value => value !== directory)) throw new Error()
    if (query.has("cursor") && path === "/api/session") {
      const scope = decodeSessionListScope(query.get("cursor")!)
      if (scope?.directory !== directory || scope.project !== undefined || scope.subpath !== undefined
        || query.has("directory") || query.has("location[directory]") || (object(body) && ("location" in body || "directory" in body))) throw new Error()
    }
    if (method === "GET" && /^\/api\/session\/[^/]+\/message$/.test(path)) {
      if (query.has("cursor") && (query.has("order") || !decodeMessageListCursor(query.get("cursor")!))) throw new Error()
      if (query.has("order") && !["asc", "desc"].includes(query.get("order")!)) throw new Error()
      if (query.has("limit") && (!/^\d+$/.test(query.get("limit")!) || Number(query.get("limit")) < 1 || Number(query.get("limit")) > 200)) throw new Error()
    }
    const budget = validatePromptAttachmentBudget(path, method, body)
    if (!budget.ok) return reply.code(budget.reason === "limit" ? 413 : 400).send({ error: "Invalid prompt attachments" })
  } catch { return reply.code(400).send({ error: "Invalid explicit workspace scope" }) }

  // Only this capture supplies endpoint, client and fetch. Never fall back to local.
  const matchesGeneration = () => expectedGeneration === undefined
    || manager.get(id)?.capabilities?.generation === Number(expectedGeneration)
  if (!matchesGeneration()) return reply.code(409).send({ error: "explicit_action_superseded" })
  if (formRead) {
    reply.header("Cache-Control", "no-store")
    const formSignal = AbortSignal.any([signal, formDeadline!])
    const formCurrent = () => {
      formSignal.throwIfAborted()
      // Parsing can finish in a microtask before the deadline timer gets its turn.
      if (performance.now() >= formExpiresAt || !matchesGeneration() || manager.get(id)?.binding !== workspace.binding) throw new Error("Form verification superseded")
      manager.requireWorkspaceCapability!(id, "questions")
    }
    try {
      const result = await readExplicitForm({
        acquire: () => Promise.resolve(manager.getSharedServiceConnection?.(id)),
        current: formCurrent,
        signal: formSignal, sessionId: formRead[1], formId: formRead[2], directory,
      })
      formCurrent()
      return reply.send(result)
    } catch {
      if (signal.aborted || reply.raw.destroyed) { reply.hijack(); return }
      return reply.code(503).send({ error: "form_verification_indeterminate" })
    }
  }
  const connection = await wait(Promise.resolve(manager.getSharedServiceConnection?.(id)))
  if (!connection) return reply.code(503).send({ error: "OpenCode service is not ready" })
  const current = () => {
    signal.throwIfAborted()
    connection.assertCurrent()
    if (!matchesGeneration()) throw new Error("Explicit action was superseded")
    if (manager.get(id)?.binding !== workspace.binding) throw new Error("Workspace changed")
    manager.requireWorkspaceCapability!(id, capability)
  }
  current()
  await wait(connection.profile(signal))
  current()
  const owns = (session: { id: string; location: { directory: string; workspaceID?: string } }) => session.id === sessionId
    && session.location.directory === directory && session.location.workspaceID === undefined
  const checkSession = async () => {
    current()
    if (!sessionId || globalForm) return
    const session = await wait(connection.client.session.get({ sessionID: sessionId }, { signal }))
    current()
    if (!owns(session)) throw new Error("Session does not belong to workspace")
  }
  try { await checkSession() } catch (error) {
    current()
    if (isSessionNotFoundError(error)) return reply.code(404).send({ _tag: "SessionNotFoundError", sessionID: sessionId, message: "Session not found" })
    if (isInvalidRequestError(error)) return reply.code(400).send({ error: "Invalid session ID" })
    return reply.code(403).send({ error: "Session does not belong to workspace" })
  }
  // prototype-1236: a shell is the project's when its working directory is the folder or inside it.
  const separator = /^[A-Za-z]:\\/.test(directory) || (directory.includes("\\") && !directory.includes("/")) ? "\\" : "/"
  const root = directory.replace(/[\\/]+$/, "")
  const ownsCwd = (cwd: unknown) => typeof cwd === "string" && (cwd.replace(/[\\/]+$/, "") === root || cwd.startsWith(root + separator))
  const shellId = path.match(/^\/api\/shell\/([^/]+)/)?.[1]
  if (shellId) {
    let shell
    try { shell = await wait(connection.client.shell.get({ id: shellId as never, location: { directory } }, { signal })) }
    catch { current(); return reply.code(404).send({ error: "Shell not found" }) }
    current()
    if (shell.location?.directory !== directory || !ownsCwd(shell.data?.cwd)) return reply.code(403).send({ error: "Shell does not belong to workspace" })
  }
  const target = new URL(path, connection.endpoint.url)
  target.search = query.toString()
  if (method === "GET" && path === "/api/session" && !query.has("cursor")) {
    target.searchParams.delete("location[directory]")
    target.searchParams.set("directory", directory)
  } else if (!sessionId && path !== "/api/session/active" && path !== "/api/session") {
    target.searchParams.delete("directory")
    target.searchParams.set("location[directory]", directory)
  }
  if (method === "POST" && path === "/api/session") body = { ...(object(body) ? body : {}), location: { directory } }
  // Allow headers by role; auth, cookies, forwarding and internal control headers
  // stay at the CodeNomad boundary. The protected target transport supplies auth.
  const headers: Record<string, string> = {}
  for (const name of ["accept", "content-type"]) if (typeof request.headers[name] === "string") headers[name] = request.headers[name]
  if (globalForm) headers["x-opencode-directory"] = encodeURIComponent(directory)
  return forwardRuntimeRequest({ request, reply, url: target.toString(), body, headers,
    invalidate: () => connection.invalidate(),
    assertCurrent: current,
    fetch: async (input, init) => {
      // Scope was read above; header/body preparation since then is synchronous.
      // Recheck lifetime and generation at the actual dispatch boundary.
      current()
      const response = await connection.fetch(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]), redirect: "error" })
      current()
      // ponytail: finite E1 responses cap at 64 MiB; a streaming reader needs its
      // own publication protocol before adding streaming operations here.
      // Hold responses until their scope and captured
      // generation are revalidated; never publish a partial stale response.
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        while (reader) {
          const chunk = await wait(reader.read())
          current()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 64 * 1024 * 1024) throw new Error("Explicit response too large")
          chunks.push(chunk.value)
        }
      } catch (error) { await reader?.cancel().catch(() => {}); throw error }
      finally { reader?.releaseLock() }
      // Deleted sessions cannot be re-read; the pre-dispatch ownership check still applies.
      if (!(method === "DELETE" && path === `/api/session/${sessionId}` && response.ok)) await checkSession()
      current()
      let bytes = Buffer.concat(chunks, size)
      if (response.ok && /^application\/json\b/i.test(response.headers.get("content-type") ?? "")) {
        const value = JSON.parse(bytes.toString("utf8"))
        if ((value.location !== undefined && (value.location?.directory !== directory || value.location.workspaceID !== undefined))
          || (path === "/api/location" && (value.directory !== directory || value.workspaceID !== undefined))) throw new Error("Unowned response location")
        if (method === "GET" && path === "/api/session/active") {
          for (const key of Object.keys(value.data ?? {})) {
            let session
            try { session = await wait(connection.client.session.get({ sessionID: key }, { signal })) }
            catch (error) {
              current()
              if (!isSessionNotFoundError(error)) throw error
              delete value.data[key]
              continue
            }
            current()
            if (session.id !== key || session.location.directory !== directory || readLocationRef(session.location).workspaceID !== undefined) delete value.data[key]
          }
        }
        if (method === "GET" && path === "/api/session" && (!Array.isArray(value.data)
          || value.data.some((session: { location?: { directory?: string; workspaceID?: string } }) => session.location?.directory !== directory || session.location.workspaceID !== undefined))) throw new Error("Unowned session list")
        if (method === "POST" && (path === "/api/session" || /\/fork$/.test(path))
          && (value.data?.location?.directory !== directory || value.data.location.workspaceID !== undefined)) throw new Error("Unowned session result")
        if (method === "GET" && path === `/api/session/${sessionId}` && !owns(value.data)) throw new Error("Unowned session result")
        if (method === "GET" && path === "/api/shell") {
          if (!Array.isArray(value.data)) throw new Error("Unowned shell list")
          value.data = value.data.filter((shell: { cwd?: unknown }) => ownsCwd(shell?.cwd))
        }
        if (method === "GET" && shellId && !path.endsWith("/output") && !ownsCwd(value.data?.cwd)) throw new Error("Unowned shell result")
        if (sessionId && method === "GET" && /\/message$/.test(path) && wantsDeferredMedia(request.headers)) deferToolMedia(value.data, { workspaceId: id, sessionId })
        bytes = Buffer.from(JSON.stringify(value))
      }
      current()
      return new Response(response.body ? bytes : null, { status: response.status, headers: response.headers })
    },
  })
}
