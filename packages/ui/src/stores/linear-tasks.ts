import { createSignal } from "solid-js"
import { ERA_CODE_API_BASE } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("linear-tasks")

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  status: string
  statusColor: string
  priority: number
  priorityLabel: string
  labels: string[]
  assignee: string | null
  url: string
  updatedAt: number
}

export type LinearConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

const [linearTasks, setLinearTasks] = createSignal<Map<string, LinearIssue[]>>(new Map())
const [linearStatus, setLinearStatus] = createSignal<LinearConnectionStatus>("disconnected")
const [linearError, setLinearError] = createSignal<string | null>(null)
const [lastSyncTime, setLastSyncTime] = createSignal<number | null>(null)

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = ERA_CODE_API_BASE ? new URL(path, ERA_CODE_API_BASE).toString() : path
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error")
    throw new Error(`Linear API error (${response.status}): ${text}`)
  }
  return (await response.json()) as T
}

export function getLinearTasks(instanceId: string): LinearIssue[] {
  return linearTasks().get(instanceId) ?? []
}

export async function fetchLinearTasks(instanceId: string): Promise<void> {
  try {
    setLinearStatus("connecting")
    const issues = await apiRequest<LinearIssue[]>(`/api/era/linear/issues?instanceId=${encodeURIComponent(instanceId)}`)
    setLinearTasks((prev) => {
      const next = new Map(prev)
      next.set(instanceId, issues)
      return next
    })
    setLinearStatus("connected")
    setLinearError(null)
    setLastSyncTime(Date.now())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn("Failed to fetch Linear tasks:", message)
    setLinearStatus("error")
    setLinearError(message)
  }
}

export async function syncLinearTasks(instanceId: string): Promise<void> {
  try {
    await apiRequest<{ ok: boolean }>("/api/era/linear/sync", {
      method: "POST",
      body: JSON.stringify({ instanceId }),
    })
    await fetchLinearTasks(instanceId)
  } catch (error) {
    log.warn("Failed to sync Linear tasks:", error)
  }
}

export function clearLinearTasks(instanceId: string): void {
  setLinearTasks((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}

export function getPriorityColor(priority: number): string {
  switch (priority) {
    case 1: return "text-destructive"
    case 2: return "text-warning"
    case 3: return "text-info"
    default: return "text-muted-foreground"
  }
}

export function getStatusDotColor(status: string): string {
  const lower = status.toLowerCase()
  if (lower === "done" || lower === "completed") return "bg-success"
  if (lower === "in progress" || lower === "started") return "bg-info"
  if (lower === "canceled" || lower === "cancelled") return "bg-muted-foreground"
  if (lower === "backlog") return "bg-muted-foreground opacity-50"
  return "bg-warning"
}

export { linearTasks, linearStatus, linearError, lastSyncTime }
