import { execFile as nodeExecFile } from "node:child_process"
import { Service, type Endpoint } from "@opencode-ai/client/service"

import { assertLoopbackServiceUrl } from "./service-state"
import type { OpenCodeServiceLifecycle } from "./opencode-service"
import type { SpawnSpec } from "./spawn"

export const MAX_SERVICE_OUTPUT_BYTES = 64 * 1024
const MAX_ERROR_CHARS = 1_024

export interface ServiceExecOptions {
  encoding: "utf8"
  maxBuffer: number
  shell: false
  timeout: number
  windowsHide: true
  cwd?: string
  env?: NodeJS.ProcessEnv
  windowsVerbatimArguments?: boolean
}

export interface ServiceExecResult {
  stdout: string
  stderr: string
}

export interface OpenCodeCliServiceDependencies {
  execFile: (file: string, args: string[], options: ServiceExecOptions) => Promise<ServiceExecResult>
  fetch: typeof globalThis.fetch
}

export interface OpenCodeCliServiceOptions {
  label: string
  timeoutMs: number
  command: (args: string[], start: boolean) => SpawnSpec
  beforeHealth?: (endpoint: Endpoint, deadlineAt: number) => Promise<void>
  unreachableMessage?: (url: string) => string
}

export class OpenCodeCliService implements OpenCodeServiceLifecycle {
  private readonly dependencies: OpenCodeCliServiceDependencies
  private readonly timeoutMs: number

  constructor(
    private readonly options: OpenCodeCliServiceOptions,
    dependencies: Partial<OpenCodeCliServiceDependencies> = {},
  ) {
    this.timeoutMs = Math.max(1, options.timeoutMs)
    this.dependencies = { execFile: executeFile, fetch: globalThis.fetch, ...dependencies }
  }

  async discover(deadlineAt = Date.now() + this.timeoutMs): Promise<Endpoint | undefined> {
    const status = this.singleLine(await this.run(["service", "status"], false, deadlineAt), "status")
    if (status === "stopped") return undefined
    return this.endpoint(status, deadlineAt)
  }

  async ensure(deadlineAt = Date.now() + this.timeoutMs): Promise<Endpoint> {
    const url = this.singleLine(await this.run(["service", "start"], true, deadlineAt), "start")
    return this.endpoint(url, deadlineAt)
  }

  private async endpoint(value: string, deadlineAt: number): Promise<Endpoint> {
    const url = this.assertServiceUrl(value)
    const password = this.singleLine(
      await this.run(["service", "get", "password"], false, deadlineAt),
      "password",
    )
    if (!password) throw new Error(`${this.options.label} OpenCode service returned an empty password`)
    const endpoint: Endpoint = { url, auth: { type: "basic", username: "opencode", password } }
    await this.options.beforeHealth?.(endpoint, deadlineAt)
    await this.validateHealth(endpoint, deadlineAt)
    return endpoint
  }

  private async run(args: string[], start: boolean, deadlineAt: number): Promise<string> {
    const commandLabel = args.join(" ")
    const timeout = this.remaining(deadlineAt, commandLabel)
    const spec = this.options.command(args, start)
    const options: ServiceExecOptions = {
      encoding: "utf8",
      maxBuffer: MAX_SERVICE_OUTPUT_BYTES,
      shell: false,
      timeout,
      windowsHide: true,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }
    try {
      const result = await this.withDeadline(
        this.dependencies.execFile(spec.command, spec.args, options),
        deadlineAt,
        commandLabel,
      )
      return result.stdout
    } catch (error) {
      if (start || commandLabel === "service get password") {
        const operation = start ? "start" : "password retrieval"
        const code = safeNumericExecCode(error)
        throw new Error(
          `${this.options.label} OpenCode ${operation} failed${code === undefined ? "" : ` (exit code ${code})`}`,
        )
      }
      const detail = boundedExecError(error)
      throw new Error(`${this.options.label} OpenCode ${commandLabel} failed${detail ? `: ${detail}` : ""}`)
    }
  }

  private async validateHealth(endpoint: Endpoint, deadlineAt: number): Promise<void> {
    let response: Response
    try {
      const timeout = this.remaining(deadlineAt, "health validation")
      response = await this.withDeadline(this.dependencies.fetch(new URL("/api/health", endpoint.url), {
        headers: Service.headers(endpoint),
        signal: AbortSignal.timeout(timeout),
      }), deadlineAt, "health validation")
    } catch {
      const message = this.options.unreachableMessage?.(endpoint.url)
      throw new Error(message ?? `Cannot reach the ${this.options.label} OpenCode service at ${endpoint.url}`)
    }
    if (response.status === 401) {
      throw new Error(`${this.options.label} OpenCode service authentication failed at ${endpoint.url} (HTTP 401)`)
    }
    if (!response.ok) {
      throw new Error(`${this.options.label} OpenCode service health check failed at ${endpoint.url} (HTTP ${response.status})`)
    }

    let health: unknown
    try {
      const body = await this.withDeadline(
        readBoundedBody(response, MAX_SERVICE_OUTPUT_BYTES),
        deadlineAt,
        "health response",
      )
      health = JSON.parse(body)
    } catch {
      throw new Error(`${this.options.label} OpenCode service returned an invalid health response at ${endpoint.url}`)
    }
    const value = health as { healthy?: unknown; version?: unknown; pid?: unknown } | null
    if (
      !value
      || typeof value !== "object"
      || value.healthy !== true
      || typeof value.version !== "string"
      || !value.version.trim()
      || !Number.isSafeInteger(value.pid)
      || Number(value.pid) <= 0
    ) {
      throw new Error(`${this.options.label} OpenCode service is not API-compatible at ${endpoint.url}`)
    }
  }

  private assertServiceUrl(value: string): string {
    let url: URL
    let wildcard = false
    try {
      wildcard = new URL(value).hostname === "0.0.0.0"
      url = assertLoopbackServiceUrl(value)
    } catch {
      throw new Error(`${this.options.label} OpenCode service returned an invalid loopback URL`)
    }
    if (/[^\S\r\n]|[\x00-\x1f\x7f]/.test(value) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`${this.options.label} OpenCode service returned an invalid loopback URL`)
    }
    return wildcard ? url.toString() : value
  }

  private singleLine(value: string, label: string): string {
    const line = value.endsWith("\r\n") ? value.slice(0, -2)
      : value.endsWith("\n") || value.endsWith("\r") ? value.slice(0, -1)
        : value
    if (line.includes("\n") || line.includes("\r")) {
      throw new Error(`${this.options.label} OpenCode service returned multiline ${label} output`)
    }
    if (line !== line.trim()) {
      throw new Error(`${this.options.label} OpenCode service returned malformed ${label} output`)
    }
    return line
  }

  private remaining(deadlineAt: number, label: string): number {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) {
      throw new Error(`${this.options.label} OpenCode ${label} timed out after ${this.timeoutMs}ms`)
    }
    return remaining
  }

  private async withDeadline<T>(operation: Promise<T>, deadlineAt: number, label: string): Promise<T> {
    const timeoutMs = this.remaining(deadlineAt, label)
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${this.options.label} OpenCode ${label} timed out after ${this.timeoutMs}ms`)),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

function executeFile(file: string, args: string[], options: ServiceExecOptions): Promise<ServiceExecResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr })
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

function boundedExecError(error: unknown): string {
  if (!error || typeof error !== "object") return clip(String(error))
  const value = error as { code?: unknown; message?: unknown; stdout?: unknown; stderr?: unknown }
  return clip([
    value.code === undefined ? "" : `code ${clip(String(value.code))}`,
    value.message === undefined ? "" : clip(String(value.message)),
    value.stderr === undefined ? "" : clip(String(value.stderr).trim()),
    value.stdout === undefined ? "" : clip(String(value.stdout).trim()),
  ].filter(Boolean).join(": "))
}

function safeNumericExecCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "number" && Number.isSafeInteger(code) ? code : undefined
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error("Response body exceeds limit")
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString("utf8")
}

function clip(value: string): string {
  return value.length <= MAX_ERROR_CHARS ? value : `${value.slice(0, MAX_ERROR_CHARS)}...`
}
