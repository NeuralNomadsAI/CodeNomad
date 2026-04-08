import { spawn, spawnSync, type ChildProcess } from "child_process"
import { createWriteStream, existsSync, promises as fs } from "fs"
import path from "path"
import { randomBytes } from "crypto"
import type { EventBus } from "../events/bus"
import type { WorkspaceManager } from "../workspaces/manager"
import type { Logger } from "../logger"
import type { BackgroundProcess, BackgroundProcessStatus, BackgroundProcessTerminalReason } from "../api-types"

const ROOT_DIR = ".codenomad/background_processes"
const INDEX_FILE = "index.json"
const OUTPUT_FILE = "output.txt"
const STOP_TIMEOUT_MS = 2000
const EXIT_WAIT_TIMEOUT_MS = 5000
const MAX_OUTPUT_BYTES = 20 * 1024
const OUTPUT_PUBLISH_INTERVAL_MS = 1000

interface ManagerDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

interface RunningProcess {
  id: string
  child: ChildProcess
  outputPath: string
  exitPromise: Promise<void>
  workspaceId: string
  completion?: ProcessCompletion
}

interface ProcessCompletion {
  reason: BackgroundProcessTerminalReason
  endContext: "normal" | "workspace_cleanup"
  removeAfterFinalize?: boolean
}

interface BackgroundProcessNotificationState {
  sessionID: string
  directory: string
  sentAt?: string
}

interface PersistedBackgroundProcess extends BackgroundProcess {
  notify?: BackgroundProcessNotificationState
}

interface StartOptions {
  notify?: boolean
  notification?: {
    sessionID: string
    directory: string
  }
}

export class BackgroundProcessManager {
  private readonly running = new Map<string, RunningProcess>()

  constructor(private readonly deps: ManagerDeps) {
    this.deps.eventBus.on("workspace.stopped", (event) => this.cleanupWorkspace(event.workspaceId))
    this.deps.eventBus.on("workspace.error", (event) => this.cleanupWorkspace(event.workspace.id))
  }

  async list(workspaceId: string): Promise<BackgroundProcess[]> {
    const records = await this.readIndex(workspaceId)
    const enriched = await Promise.all(
      records.map(async (record) => ({
        ...this.toPublicProcess(record),
        outputSizeBytes: await this.getOutputSize(workspaceId, record.id),
      })),
    )
    return enriched
  }

  async start(workspaceId: string, title: string, command: string, options: StartOptions = {}): Promise<BackgroundProcess> {
    const workspace = this.deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      throw new Error("Workspace not found")
    }

    const id = this.generateId()
    const processDir = await this.ensureProcessDir(workspaceId, id)
    const outputPath = path.join(processDir, OUTPUT_FILE)

    const outputStream = createWriteStream(outputPath, { flags: "a" })

    const { shellCommand, shellArgs, spawnOptions } = this.buildShellSpawn(command)

    const child = spawn(shellCommand, shellArgs, {
      cwd: workspace.path,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...spawnOptions,
    })

    child.on("exit", () => {
      this.killProcessTree(child, "SIGTERM")
    })

    const record: PersistedBackgroundProcess = {
      id,
      workspaceId,
      title,
      command,
      cwd: workspace.path,
      status: "running",
      pid: child.pid,
      startedAt: new Date().toISOString(),
      outputSizeBytes: 0,
      notify: options.notify && options.notification
        ? {
            sessionID: options.notification.sessionID,
            directory: options.notification.directory,
          }
        : undefined,
    }

    const runningState: RunningProcess = {
      id,
      child,
      outputPath,
      exitPromise: Promise.resolve(),
      workspaceId,
    }

    const exitPromise = new Promise<void>((resolve) => {
      child.on("close", async (code) => {
        await new Promise<void>((resolve) => outputStream.end(resolve))
        this.running.delete(id)

        const completion = runningState.completion ?? this.completionFromExit(code)

        record.terminalReason = completion.reason
        record.status = this.statusFromReason(completion.reason)
        record.exitCode = code === null ? undefined : code
        record.stoppedAt = new Date().toISOString()

        await this.finalizeRecord(workspaceId, record, completion)
        resolve()
      })
    })

    runningState.exitPromise = exitPromise

    this.running.set(id, runningState)

    let lastPublishAt = 0
    const maybePublishSize = () => {
      const now = Date.now()
      if (now - lastPublishAt < OUTPUT_PUBLISH_INTERVAL_MS) {
        return
      }
      lastPublishAt = now
      this.publishUpdate(workspaceId, record)
    }

    child.stdout?.on("data", (data) => {
      outputStream.write(data)
      record.outputSizeBytes = (record.outputSizeBytes ?? 0) + data.length
      maybePublishSize()
    })
    child.stderr?.on("data", (data) => {
      outputStream.write(data)
      record.outputSizeBytes = (record.outputSizeBytes ?? 0) + data.length
      maybePublishSize()
    })

    await this.upsertIndex(workspaceId, record)
    record.outputSizeBytes = await this.getOutputSize(workspaceId, record.id)
    this.publishUpdate(workspaceId, record)
    return this.toPublicProcess(record)
  }

  async stop(workspaceId: string, processId: string): Promise<BackgroundProcess | null> {
    const record = await this.findProcess(workspaceId, processId)
    if (!record) {
      return null
    }

    const running = this.running.get(processId)
    if (running?.child && !running.child.killed) {
      running.completion = { reason: "user_stopped", endContext: "normal" }
      this.killProcessTree(running.child, "SIGTERM")
      await this.waitForExit(running)
      const updated = await this.findProcess(workspaceId, processId)
      return updated ? this.toPublicProcess(updated) : this.toPublicProcess(record)
    }

    if (record.status === "running") {
      record.status = "stopped"
      record.terminalReason = "user_stopped"
      record.stoppedAt = new Date().toISOString()
      await this.finalizeRecord(workspaceId, record, { reason: "user_stopped", endContext: "normal" })
    }

    return this.toPublicProcess(record)
  }

  async terminate(workspaceId: string, processId: string): Promise<void> {
    const record = await this.findProcess(workspaceId, processId)
    if (!record) return

    const running = this.running.get(processId)
    if (running?.child && !running.child.killed) {
      running.completion = { reason: "user_terminated", endContext: "normal", removeAfterFinalize: true }
      this.killProcessTree(running.child, "SIGTERM")
      await this.waitForExit(running)
      return
    }

    record.status = "stopped"
    record.terminalReason = "user_terminated"
    record.stoppedAt = new Date().toISOString()
    await this.finalizeRecord(workspaceId, record, {
      reason: "user_terminated",
      endContext: "normal",
      removeAfterFinalize: true,
    })
  }

  async readOutput(
    workspaceId: string,
    processId: string,
    options: { method?: "full" | "tail" | "head" | "grep"; pattern?: string; lines?: number; maxBytes?: number },
  ) {
    const outputPath = this.getOutputPath(workspaceId, processId)
    if (!existsSync(outputPath)) {
      return { id: processId, content: "", truncated: false, sizeBytes: 0 }
    }

    const stats = await fs.stat(outputPath)
    const sizeBytes = stats.size
    const method = options.method ?? "full"
    const lineCount = options.lines ?? 10

    const raw = await this.readOutputBytes(outputPath, sizeBytes, options.maxBytes)
    let content = raw

    switch (method) {
      case "head":
        content = this.headLines(raw, lineCount)
        break
      case "tail":
        content = this.tailLines(raw, lineCount)
        break
      case "grep":
        if (!options.pattern) {
          throw new Error("Pattern is required for grep output")
        }
        content = this.grepLines(raw, options.pattern)
        break
      default:
        content = raw
    }

    const effectiveMaxBytes = options.maxBytes
    return {
      id: processId,
      content,
      truncated: effectiveMaxBytes !== undefined && sizeBytes > effectiveMaxBytes,
      sizeBytes,
    }
  }

  async streamOutput(workspaceId: string, processId: string, reply: any) {
    const outputPath = this.getOutputPath(workspaceId, processId)
    if (!existsSync(outputPath)) {
      reply.code(404).send({ error: "Output not found" })
      return
    }

    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    const file = await fs.open(outputPath, "r")
    let position = (await file.stat()).size

    const tick = async () => {
      const stats = await file.stat()
      if (stats.size <= position) return

      const length = stats.size - position
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, position)
      position = stats.size

      const content = buffer.toString("utf-8")
      reply.raw.write(`data: ${JSON.stringify({ type: "chunk", content })}\n\n`)
    }

    const interval = setInterval(() => {
      tick().catch((error) => {
        this.deps.logger.warn({ err: error }, "Failed to stream background process output")
      })
    }, 1000)

    const close = () => {
      clearInterval(interval)
      file.close().catch(() => undefined)
      reply.raw.end?.()
    }

    reply.raw.on("close", close)
    reply.raw.on("error", close)
  }

  private async cleanupWorkspace(workspaceId: string) {
    for (const [, running] of this.running.entries()) {
      if (running.workspaceId !== workspaceId) continue
      running.completion = {
        reason: "user_terminated",
        endContext: "workspace_cleanup",
        removeAfterFinalize: true,
      }
      this.killProcessTree(running.child, "SIGTERM")
      await this.waitForExit(running)
    }

    await this.removeWorkspaceDir(workspaceId)
  }

  private killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
    const pid = child.pid
    if (!pid) return

    if (process.platform === "win32") {
      const args = this.buildWindowsTaskkillArgs(pid, signal)
      try {
        spawnSync("taskkill", args, { stdio: "ignore" })
        return
      } catch {
        // Fall back to killing the direct child.
      }
    } else {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Fall back to killing the direct child.
      }
    }

    try {
      child.kill(signal)
    } catch {
      // ignore
    }
  }

  private async waitForExit(running: RunningProcess) {
    let exited = false
    const exitPromise = running.exitPromise.finally(() => {
      exited = true
    })

    const killTimeout = setTimeout(() => {
      if (!exited) {
        this.killProcessTree(running.child, "SIGKILL")
      }
    }, STOP_TIMEOUT_MS)

    try {
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, EXIT_WAIT_TIMEOUT_MS)
        }),
      ])

      if (!exited) {
        this.killProcessTree(running.child, "SIGKILL")
        this.running.delete(running.id)
        this.deps.logger.warn({ pid: running.child.pid }, "Timed out waiting for background process to exit")
      }
    } finally {
      clearTimeout(killTimeout)
    }
  }


  private buildShellSpawn(command: string): { shellCommand: string; shellArgs: string[]; spawnOptions?: Record<string, unknown> } {
    if (process.platform === "win32") {
      const comspec = process.env.ComSpec || "cmd.exe"
      return {
        shellCommand: comspec,
        shellArgs: ["/d", "/s", "/c", command],
        spawnOptions: { windowsVerbatimArguments: true },
      }
    }

    // Keep bash for macOS/Linux.
    return { shellCommand: "bash", shellArgs: ["-c", command] }
  }

  private buildWindowsTaskkillArgs(pid: number, signal: NodeJS.Signals): string[] {
    // Default to graceful termination (no /F), then force kill when we escalate.
    const force = signal === "SIGKILL"
    const args = ["/PID", String(pid), "/T"]
    if (force) {
      args.push("/F")
    }
    return args
  }

  private completionFromExit(code: number | null): ProcessCompletion {
    if (code === 0) {
      return { reason: "finished", endContext: "normal" }
    }

    return { reason: "failed", endContext: "normal" }
  }

  private statusFromReason(reason: BackgroundProcessTerminalReason): BackgroundProcessStatus {
    if (reason === "failed") return "error"
    return "stopped"
  }

  private async readOutputBytes(outputPath: string, sizeBytes: number, maxBytes?: number): Promise<string> {
    if (maxBytes === undefined || sizeBytes <= maxBytes) {
      return await fs.readFile(outputPath, "utf-8")
    }

    const start = Math.max(0, sizeBytes - maxBytes)
    const file = await fs.open(outputPath, "r")
    const buffer = Buffer.alloc(sizeBytes - start)
    await file.read(buffer, 0, buffer.length, start)
    await file.close()
    return buffer.toString("utf-8")
  }

  private headLines(input: string, lines: number): string {
    const parts = input.split(/\r?\n/)
    return parts.slice(0, Math.max(0, lines)).join("\n")
  }

  private tailLines(input: string, lines: number): string {
    const parts = input.split(/\r?\n/)
    return parts.slice(Math.max(0, parts.length - lines)).join("\n")
  }

  private grepLines(input: string, pattern: string): string {
    let matcher: RegExp
    try {
      matcher = new RegExp(pattern)
    } catch {
      throw new Error("Invalid grep pattern")
    }
    return input
      .split(/\r?\n/)
      .filter((line) => matcher.test(line))
      .join("\n")
  }

  private async ensureProcessDir(workspaceId: string, processId: string) {
    const root = await this.ensureWorkspaceDir(workspaceId)
    const processDir = path.join(root, processId)
    await fs.mkdir(processDir, { recursive: true })
    return processDir
  }

  private async ensureWorkspaceDir(workspaceId: string) {
    const workspace = this.deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    const root = path.join(workspace.path, ROOT_DIR, workspaceId)
    await fs.mkdir(root, { recursive: true })
    return root
  }

  private getOutputPath(workspaceId: string, processId: string) {
    const workspace = this.deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    return path.join(workspace.path, ROOT_DIR, workspaceId, processId, OUTPUT_FILE)
  }

  private async findProcess(workspaceId: string, processId: string): Promise<PersistedBackgroundProcess | null> {
    const records = await this.readIndex(workspaceId)
    return records.find((entry) => entry.id === processId) ?? null
  }

  private async readIndex(workspaceId: string): Promise<PersistedBackgroundProcess[]> {
    const indexPath = await this.getIndexPath(workspaceId)
    if (!existsSync(indexPath)) return []

    try {
      const raw = await fs.readFile(indexPath, "utf-8")
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as PersistedBackgroundProcess[]) : []
    } catch {
      return []
    }
  }

  private async upsertIndex(workspaceId: string, record: PersistedBackgroundProcess) {
    const records = await this.readIndex(workspaceId)
    const index = records.findIndex((entry) => entry.id === record.id)
    if (index >= 0) {
      records[index] = record
    } else {
      records.push(record)
    }
    await this.writeIndex(workspaceId, records)
  }

  private async removeFromIndex(workspaceId: string, processId: string) {
    const records = await this.readIndex(workspaceId)
    const next = records.filter((entry) => entry.id !== processId)
    await this.writeIndex(workspaceId, next)
  }

  private async writeIndex(workspaceId: string, records: PersistedBackgroundProcess[]) {
    const indexPath = await this.getIndexPath(workspaceId)
    await fs.mkdir(path.dirname(indexPath), { recursive: true })
    await fs.writeFile(indexPath, JSON.stringify(records, null, 2))
  }

  private async getIndexPath(workspaceId: string) {
    const workspace = this.deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    return path.join(workspace.path, ROOT_DIR, workspaceId, INDEX_FILE)
  }

  private async removeProcessDir(workspaceId: string, processId: string) {
    const workspace = this.deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      return
    }
    const processDir = path.join(workspace.path, ROOT_DIR, workspaceId, processId)
    await fs.rm(processDir, { recursive: true, force: true })
  }

  private async removeWorkspaceDir(workspaceId: string) {
    const workspace = this.deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      return
    }
    const workspaceDir = path.join(workspace.path, ROOT_DIR, workspaceId)
    await fs.rm(workspaceDir, { recursive: true, force: true })
  }

  private async getOutputSize(workspaceId: string, processId: string): Promise<number> {
    const outputPath = this.getOutputPath(workspaceId, processId)
    if (!existsSync(outputPath)) {
      return 0
    }
    try {
      const stats = await fs.stat(outputPath)
      return stats.size
    } catch {
      return 0
    }
  }

  private publishUpdate(workspaceId: string, record: PersistedBackgroundProcess) {
    this.deps.eventBus.publish({
      type: "instance.event",
      instanceId: workspaceId,
      event: { type: "background.process.updated", properties: { process: this.toPublicProcess(record) } },
    })
  }

  private toPublicProcess(record: PersistedBackgroundProcess): BackgroundProcess {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      title: record.title,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      pid: record.pid,
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      exitCode: record.exitCode,
      outputSizeBytes: record.outputSizeBytes,
      terminalReason: record.terminalReason,
    }
  }

  private async finalizeRecord(workspaceId: string, record: PersistedBackgroundProcess, completion: ProcessCompletion) {
    if (this.shouldSendCompletionPrompt(record, completion)) {
      try {
        await this.sendCompletionPrompt(workspaceId, record)
        if (record.notify) {
          record.notify.sentAt = new Date().toISOString()
        }
      } catch (error) {
        this.deps.logger.warn({ err: error, workspaceId, processId: record.id }, "Failed to send background process completion prompt")
      }
    }

    if (completion.removeAfterFinalize) {
      await this.removeFromIndex(workspaceId, record.id)
      await this.removeProcessDir(workspaceId, record.id)

      this.deps.eventBus.publish({
        type: "instance.event",
        instanceId: workspaceId,
        event: { type: "background.process.removed", properties: { processId: record.id } },
      })
      return
    }

    await this.upsertIndex(workspaceId, record)
    record.outputSizeBytes = await this.getOutputSize(workspaceId, record.id)
    this.publishUpdate(workspaceId, record)
  }

  private shouldSendCompletionPrompt(record: PersistedBackgroundProcess, completion: ProcessCompletion) {
    if (completion.endContext === "workspace_cleanup") return false
    if (!record.notify) return false
    return !record.notify.sentAt
  }

  private async sendCompletionPrompt(workspaceId: string, record: PersistedBackgroundProcess) {
    const notify = record.notify
    if (!notify || !record.terminalReason) return

    if (!this.deps.workspaceManager.get(workspaceId)) {
      throw new Error("Workspace not found")
    }

    const port = this.deps.workspaceManager.getInstancePort(workspaceId)
    if (!port) {
      throw new Error("Workspace instance is not ready")
    }

    const targetUrl = `http://127.0.0.1:${port}/session/${encodeURIComponent(notify.sessionID)}/prompt_async`
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-opencode-directory": /[^\x00-\x7F]/.test(notify.directory) ? encodeURIComponent(notify.directory) : notify.directory,
    }

    const authorization = this.deps.workspaceManager.getInstanceAuthorizationHeader(workspaceId)
    if (authorization) {
      headers.authorization = authorization
    }

    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parts: [
          {
            type: "text",
            text: this.buildSyntheticCompletionPrompt(record),
            synthetic: true,
          },
        ],
      }),
    })

    if (!response.ok) {
      const message = await response.text().catch(() => "")
      throw new Error(message || `Prompt request failed with ${response.status}`)
    }
  }

  private buildCompletionPrompt(record: PersistedBackgroundProcess): string {
    const ref = `Background process "${record.title}" (${record.id})`

    switch (record.terminalReason) {
      case "finished":
        return `${ref} finished successfully.`
      case "failed":
        return record.exitCode === undefined ? `${ref} failed.` : `${ref} failed with exit code ${record.exitCode}.`
      case "user_stopped":
        return `${ref} was stopped by user.`
      case "user_terminated":
        return `${ref} was terminated by user.`
    }

    return `${ref} ended.`
  }

  private buildSyntheticCompletionPrompt(record: PersistedBackgroundProcess): string {
    return `<system-message>${this.escapeTaggedText(this.buildCompletionPrompt(record))}</system-message>`
  }

  private escapeTaggedText(input: string): string {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  }

  private generateId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)
    const random = randomBytes(3).toString("hex")
    return `proc_${timestamp}_${random}`
  }
}
