import type { Instance } from "../types/instance"
import type { McpServerConfig } from "../stores/preferences"
import type { QuestionAnswer, QuestionRequest } from "../stores/question-store"
import { ERA_CODE_API_BASE } from "./api-client"

/**
 * Structured error from instance API with additional context
 */
export interface InstanceApiError extends Error {
  code?: string
  hint?: string
  status?: number
  originalStatus?: number
}

function normalizeProxyPath(proxyPath: string): string {
  const withLeading = proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`
  return withLeading.replace(/\/+/g, "/").replace(/\/+$/, "")
}

function buildInstanceBaseUrl(proxyPath: string): string {
  const normalized = normalizeProxyPath(proxyPath)
  const base = ERA_CODE_API_BASE.replace(/\/+$/, "")
  return `${base}${normalized}`
}

/**
 * Create a structured error from an API response
 */
function createInstanceError(status: number, body: unknown): InstanceApiError {
  let message = `Instance request failed (${status})`
  let code: string | undefined
  let hint: string | undefined
  let originalStatus: number | undefined

  if (typeof body === "object" && body !== null) {
    const errorBody = body as Record<string, unknown>
    if (typeof errorBody.error === "string") {
      message = errorBody.error
    }
    if (typeof errorBody.code === "string") {
      code = errorBody.code
    }
    if (typeof errorBody.hint === "string") {
      hint = errorBody.hint
    }
    if (typeof errorBody.originalStatus === "number") {
      originalStatus = errorBody.originalStatus
    }
  } else if (typeof body === "string" && body.length > 0) {
    message = body
  }

  const error = new Error(message) as InstanceApiError
  error.code = code
  error.hint = hint
  error.status = status
  error.originalStatus = originalStatus
  return error
}

async function requestInstance<T>(instance: Instance, path: string, init?: RequestInit): Promise<T> {
  const url = `${buildInstanceBaseUrl(instance.proxyPath)}${path}`
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    let body: unknown
    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) {
      try {
        body = await response.json()
      } catch {
        body = await response.text()
      }
    } else {
      body = await response.text()
    }
    throw createInstanceError(response.status, body)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

async function upsertMcp(instance: Instance, name: string, config: McpServerConfig) {
  // opencode server: POST /mcp { name, config }
  return requestInstance<Record<string, unknown>>(instance, "/mcp", {
    method: "POST",
    body: JSON.stringify({ name, config }),
  })
}

async function connectMcp(instance: Instance, name: string) {
  // Prefer the SDK method if present.
  if (instance.client?.mcp?.connect) {
    await instance.client.mcp.connect({ path: { name } })
    return
  }
  await requestInstance(instance, `/mcp/${encodeURIComponent(name)}/connect`, { method: "POST" })
}

async function disconnectMcp(instance: Instance, name: string) {
  if (instance.client?.mcp?.disconnect) {
    await instance.client.mcp.disconnect({ path: { name } })
    return
  }
  await requestInstance(instance, `/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST" })
}

async function listQuestions(instance: Instance): Promise<QuestionRequest[]> {
  return requestInstance<QuestionRequest[]>(instance, "/question")
}

async function replyToQuestion(
  instance: Instance,
  requestId: string,
  answers: QuestionAnswer[],
): Promise<void> {
  await requestInstance(instance, `/question/${encodeURIComponent(requestId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  })
}

async function rejectQuestion(instance: Instance, requestId: string): Promise<void> {
  await requestInstance(instance, `/question/${encodeURIComponent(requestId)}/reject`, {
    method: "POST",
  })
}

export const instanceApi = {
  upsertMcp,
  connectMcp,
  disconnectMcp,
  listQuestions,
  replyToQuestion,
  rejectQuestion,
}
