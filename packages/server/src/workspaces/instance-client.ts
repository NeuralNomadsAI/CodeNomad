import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { WorkspaceManager } from "./manager"
import { LOOPBACK_HOST } from "./loopback"

const LOOPBACK_TIMEOUT_MS = 10_000

interface InstanceClientOptions {
  timeoutMs?: number
  /**
   * Directory the instance should scope the call to. Defaults to the
   * workspace root; pass an explicit path when targeting a session that
   * lives elsewhere (e.g. a worktree) so OpenCode resolves the right
   * project context.
   */
  directory?: string
}

/**
 * Creates an OpenCode SDK client for direct loopback communication with a
 * running workspace instance.
 *
 * Routes and body shapes come from the auto-generated SDK contract
 * (`@opencode-ai/sdk`), eliminating handwritten URL construction that can
 * drift between SDK versions. Other server modules that need to call the
 * OpenCode instance directly should use this factory rather than building
 * `http://127.0.0.1:{port}/...` URLs by hand.
 *
 * Requests carry a 10-second timeout (configurable via `timeoutMs`) —
 * loopback calls should be near-instant; a hang indicates a stuck instance.
 *
 * The client is cheap to create (object only, no connection); create one per
 * call or cache per instance as needed. Returns `null` when the instance has
 * no open port yet.
 */
export function createInstanceClient(
  workspaceManager: WorkspaceManager,
  instanceId: string,
  options: InstanceClientOptions = {},
): OpencodeClient | null {
  const port = workspaceManager.getInstancePort(instanceId)
  if (!port) return null

  const headers: Record<string, string> = {}
  const authorization = workspaceManager.getInstanceAuthorizationHeader(instanceId)
  if (authorization) {
    headers.authorization = authorization
  }

  const workspace = workspaceManager.get(instanceId)
  const timeoutMs = options.timeoutMs ?? LOOPBACK_TIMEOUT_MS
  const directory = options.directory ?? workspace?.path

  return createOpencodeClient({
    baseUrl: `http://${LOOPBACK_HOST}:${port}/`,
    headers,
    fetch: (url, init) => {
      const requestInit = init as RequestInit | undefined
      const sources = [
        ...(url instanceof Request ? [url.signal] : []),
        ...(requestInit?.signal ? [requestInit.signal] : []),
      ]
      const { signal, cleanup } = composeRequestSignal(sources, timeoutMs)
      return fetch(url, { ...requestInit, signal }).then(
        (response) => responseWithSignalCleanup(response, cleanup),
        (error) => {
          cleanup()
          throw error
        },
      )
    },
    ...(directory ? { directory } : {}),
  })
}

function composeRequestSignal(
  sources: readonly AbortSignal[],
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (timeout) clearTimeout(timeout)
    for (const [source, listener] of listeners) source.removeEventListener("abort", listener)
    listeners.clear()
  }
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason)
    cleanup()
  }

  for (const source of new Set(sources)) {
    if (source.aborted) {
      abort(source.reason)
      break
    }
    const listener = () => abort(source.reason)
    listeners.set(source, listener)
    source.addEventListener("abort", listener, { once: true })
  }

  if (!controller.signal.aborted) {
    timeout = setTimeout(
      () => abort(new DOMException("Request timed out", "TimeoutError")),
      timeoutMs,
    )
  }

  return { signal: controller.signal, cleanup }
}

function responseWithSignalCleanup(response: Response, cleanup: () => void): Response | Promise<Response> {
  if (!response.body || response.headers.get("content-length") === "0") {
    cleanup()
    return response
  }

  // The SDK rejects this response in an interceptor before reading its body.
  if (response.headers.get("content-type") === "text/html") {
    return response.body.cancel().catch(() => undefined).then(() => response).finally(cleanup)
  }

  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          cleanup()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        cleanup()
        controller.error(error)
      }
    },
    async cancel(reason) {
      cleanup()
      await reader.cancel(reason)
    },
  })
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperties(wrapped, {
    redirected: { value: response.redirected },
    type: { value: response.type },
    url: { value: response.url },
  })
  return wrapped
}
