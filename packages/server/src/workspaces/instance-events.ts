import { Agent, fetch } from "undici"
import { Agent as UndiciAgent } from "undici"
import { randomUUID } from "node:crypto"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { WorkspaceManager } from "./manager"
import { InstanceStreamEvent, InstanceStreamStatus } from "../api-types"

const INSTANCE_HOST = "127.0.0.1"
const STREAM_AGENT = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 })
const RECONNECT_DELAY_MS = 1000
const MAX_EVENT_BUFFER_CHARACTERS = 16 * 1024 * 1024

interface InstanceEventBridgeOptions {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

interface ActiveStream {
  controller: AbortController
  streamId: string
  runtimePid?: number
  task: Promise<void>
}

export class InstanceEventBridge {
  private readonly streams = new Map<string, ActiveStream>()

  constructor(private readonly options: InstanceEventBridgeOptions) {
    const bus = this.options.eventBus
    bus.on("workspace.started", (event) => this.startStream(event.workspace.id, event.workspace.pid))
    bus.on("workspace.stopped", (event) => this.stopStream(event.workspaceId, "workspace stopped"))
    bus.on("workspace.error", (event) => this.stopStream(event.workspace.id, "workspace error"))
  }

  shutdown() {
    for (const [id, active] of this.streams) {
      active.controller.abort()
      this.publishStatus(id, active.streamId, "disconnected")
    }
    this.streams.clear()
  }

  private startStream(workspaceId: string, runtimePid?: number) {
    const existing = this.streams.get(workspaceId)
    if (existing) {
      if (existing.runtimePid === runtimePid) return
      this.stopStream(workspaceId, "workspace restarted")
    }

    const controller = new AbortController()
    const streamId = randomUUID()
    const task = this.runStream(workspaceId, streamId, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.options.logger.warn({ workspaceId, err: error }, "Instance event stream failed")
          this.publishStatus(workspaceId, streamId, "error", error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        const active = this.streams.get(workspaceId)
        if (active?.controller === controller) {
          this.streams.delete(workspaceId)
        }
      })

    this.streams.set(workspaceId, { controller, streamId, runtimePid, task })
  }

  private stopStream(workspaceId: string, reason?: string) {
    const active = this.streams.get(workspaceId)
    if (!active) {
      return
    }
    active.controller.abort()
    this.streams.delete(workspaceId)
    this.publishStatus(workspaceId, active.streamId, "disconnected", reason)
  }

  private async runStream(workspaceId: string, streamId: string, signal: AbortSignal) {
    while (!signal.aborted) {
      const port = this.options.workspaceManager.getInstancePort(workspaceId)
      if (!port) {
        await this.delay(RECONNECT_DELAY_MS, signal)
        continue
      }

      this.publishStatus(workspaceId, streamId, "connecting")

      try {
        await this.consumeStream(workspaceId, streamId, port, signal)
        if (!signal.aborted) await this.delay(RECONNECT_DELAY_MS, signal)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        this.options.logger.warn({ workspaceId, err: error }, "Instance event stream disconnected")
        this.publishStatus(workspaceId, streamId, "error", error instanceof Error ? error.message : String(error))
        await this.delay(RECONNECT_DELAY_MS, signal)
      }
    }
  }

  private async consumeStream(workspaceId: string, streamId: string, port: number, signal: AbortSignal) {
    const url = `http://${INSTANCE_HOST}:${port}/global/event`

    const headers: Record<string, string> = { Accept: "text/event-stream" }
    const authHeader = this.options.workspaceManager.getInstanceAuthorizationHeader(workspaceId)
    if (authHeader) {
      headers["Authorization"] = authHeader
    }

    const response = await fetch(url, {
      headers,
      signal,
      dispatcher: STREAM_AGENT,
    })

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Instance event stream unavailable (${response.status})`)
    }

    this.publishStatus(workspaceId, streamId, "connected")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done || !value) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        buffer = this.flushEvents(buffer, workspaceId, streamId)
        if (buffer.length > MAX_EVENT_BUFFER_CHARACTERS) {
          throw new Error("Instance event exceeded the stream buffer limit")
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private flushEvents(buffer: string, workspaceId: string, streamId: string) {
    let separator = /\r\n\r\n|\r\r|\n\n/.exec(buffer)

    while (separator) {
      const separatorIndex = separator.index
      const chunk = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + separator[0].length)
      if (chunk.length > MAX_EVENT_BUFFER_CHARACTERS) throw new Error("Instance event exceeded the stream buffer limit")
      this.processChunk(chunk, workspaceId, streamId)
      separator = /\r\n\r\n|\r\r|\n\n/.exec(buffer)
    }

    return buffer
  }

  private processChunk(chunk: string, workspaceId: string, streamId: string) {
    const lines = chunk.split(/\r\n|\r|\n/)
    const dataLines: string[] = []

    for (const line of lines) {
      if (line.startsWith(":")) {
        continue
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    if (dataLines.length === 0) {
      return
    }

    const payload = dataLines.join("\n").trim()
    if (!payload) {
      return
    }

    try {
      const parsed = JSON.parse(payload) as any
      if (!parsed || typeof parsed !== "object") {
        this.options.logger.warn({ workspaceId, chunk: payload }, "Dropped malformed instance event")
        return
      }

      // OpenCode SSE payload shapes vary across versions.
      // Common variants:
      // - { type, properties, ... }
      // - { payload: { type, properties, ... }, directory: "/abs/path" }
      // - { payload: { type, properties, ... } }
      const base = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : parsed

      const event: InstanceStreamEvent | null = base && typeof base === "object" ? ({ ...base } as any) : null

      // Attach directory when available (don't overwrite if already present).
      if (event && !(event as any).directory && typeof (parsed as any).directory === "string") {
        ;(event as any).directory = (parsed as any).directory
      }

      if (!event || typeof (event as any).type !== "string") {
        this.options.logger.warn({ workspaceId, chunk: payload }, "Dropped malformed instance event")
        return
      }

      this.options.logger.debug({ workspaceId, eventType: (event as any).type }, "Instance SSE event received")
      if (this.options.logger.isLevelEnabled("trace")) {
        this.options.logger.trace({ workspaceId, event }, "Instance SSE event payload")
      }
      this.options.eventBus.publish({ type: "instance.event", instanceId: workspaceId, streamId, event })
    } catch (error) {
      this.options.logger.warn({ workspaceId, chunk: payload, err: error }, "Failed to parse instance SSE payload")
    }
  }

  private publishStatus(instanceId: string, streamId: string, status: InstanceStreamStatus, reason?: string) {
    this.options.logger.debug({ instanceId, streamId, status, reason }, "Instance SSE status updated")
    this.options.eventBus.publish({ type: "instance.eventStatus", instanceId, streamId, status, reason })
  }

  private delay(duration: number, signal: AbortSignal) {
    if (duration <= 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }, duration)

      const onAbort = () => {
        clearTimeout(timeout)
        resolve()
      }

      signal.addEventListener("abort", onAbort, { once: true })
    })
  }
}
