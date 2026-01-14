import { Agent, fetch } from "undici"
import { Agent as UndiciAgent } from "undici"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { WorkspaceManager } from "./manager"
import { InstanceStreamEvent, InstanceStreamStatus } from "../api-types"

const INSTANCE_HOST = "127.0.0.1"
const STREAM_AGENT = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 })
const RECONNECT_DELAY_MS = 1000

interface InstanceEventBridgeOptions {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

interface ActiveStream {
  controller: AbortController
  task: Promise<void>
}

export class InstanceEventBridge {
  private readonly streams = new Map<string, ActiveStream>()

  constructor(private readonly options: InstanceEventBridgeOptions) {
    const bus = this.options.eventBus
    bus.on("workspace.started", (event) => this.startStream(event.workspace.id))
    bus.on("workspace.stopped", (event) => this.stopStream(event.workspaceId, "workspace stopped"))
    bus.on("workspace.error", (event) => this.stopStream(event.workspace.id, "workspace error"))
  }

  shutdown() {
    for (const [id, active] of this.streams) {
      active.controller.abort()
      this.publishStatus(id, "disconnected")
    }
    this.streams.clear()
  }

  private startStream(workspaceId: string) {
    if (this.streams.has(workspaceId)) {
      return
    }

    const controller = new AbortController()
    const task = this.runStream(workspaceId, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.options.logger.warn({ workspaceId, err: error }, "Instance event stream failed")
          this.publishStatus(workspaceId, "error", error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        const active = this.streams.get(workspaceId)
        if (active?.controller === controller) {
          this.streams.delete(workspaceId)
        }
      })

    this.streams.set(workspaceId, { controller, task })
  }

  private stopStream(workspaceId: string, reason?: string) {
    const active = this.streams.get(workspaceId)
    if (!active) {
      return
    }
    active.controller.abort()
    this.streams.delete(workspaceId)
    this.publishStatus(workspaceId, "disconnected", reason)
  }

  private async runStream(workspaceId: string, signal: AbortSignal) {
    while (!signal.aborted) {
      const port = this.options.workspaceManager.getInstancePort(workspaceId)
      if (!port) {
        await this.delay(RECONNECT_DELAY_MS, signal)
        continue
      }

      this.publishStatus(workspaceId, "connecting")

      try {
        await this.consumeStream(workspaceId, port, signal)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        this.options.logger.warn({ workspaceId, err: error }, "Instance event stream disconnected")
        this.publishStatus(workspaceId, "error", error instanceof Error ? error.message : String(error))
        await this.delay(RECONNECT_DELAY_MS, signal)
      }
    }
  }

  private async consumeStream(workspaceId: string, port: number, signal: AbortSignal) {
    const url = `http://${INSTANCE_HOST}:${port}/event`

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
      throw new Error(`Instance event stream unavailable (${response.status})`)
    }

    this.publishStatus(workspaceId, "connected")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done || !value) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      buffer = this.flushEvents(buffer, workspaceId)
    }
  }

  private flushEvents(buffer: string, workspaceId: string) {
    let separatorIndex = buffer.indexOf("\n\n")

    while (separatorIndex >= 0) {
      const chunk = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)
      this.processChunk(chunk, workspaceId)
      separatorIndex = buffer.indexOf("\n\n")
    }

    return buffer
  }

  private processChunk(chunk: string, workspaceId: string) {
    const lines = chunk.split(/\r?\n/)
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
      const event = JSON.parse(payload) as InstanceStreamEvent
      this.options.logger.debug({ workspaceId, eventType: event.type }, "Instance SSE event received")
      if (this.options.logger.isLevelEnabled("trace")) {
        this.options.logger.trace({ workspaceId, event }, "Instance SSE event payload")
      }
      this.options.eventBus.publish({ type: "instance.event", instanceId: workspaceId, event })
    } catch (error) {
      this.options.logger.warn({ workspaceId, chunk: payload, err: error }, "Failed to parse instance SSE payload")
    }
  }

  private publishStatus(instanceId: string, status: InstanceStreamStatus, reason?: string) {
    this.options.logger.debug({ instanceId, status, reason }, "Instance SSE status updated")
    this.options.eventBus.publish({ type: "instance.eventStatus", instanceId, status, reason })
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
