import { Transform } from "node:stream"
import pino, { Logger as PinoLogger } from "pino"

export type Logger = PinoLogger

interface LoggerOptions {
  level?: string
  destination?: string
  component?: string
}

const LEVEL_LABELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
}

const LIFECYCLE_COMPONENTS = new Set(["app", "workspace"])
const OMITTED_FIELDS = new Set(["time", "msg", "level", "component", "module"])

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = (options.level ?? process.env.CLI_LOG_LEVEL ?? "info").toLowerCase()
  const destination = options.destination ?? process.env.CLI_LOG_DESTINATION ?? "stdout"
  const baseComponent = options.component ?? "app"
  const loggerOptions = {
    level,
    base: { component: baseComponent },
    timestamp: false,
  } as const

  if (destination && destination !== "stdout") {
    const stream = pino.destination({ dest: destination, mkdir: true, sync: false })
    return pino(loggerOptions, stream)
  }

  const lifecycleStream = new LifecycleLogStream({ restrictInfoToLifecycle: level === "info" })
  lifecycleStream.pipe(process.stdout)
  return pino(loggerOptions, lifecycleStream)
}

interface LifecycleStreamOptions {
  restrictInfoToLifecycle: boolean
}

class LifecycleLogStream extends Transform {
  private buffer = ""

  constructor(private readonly options: LifecycleStreamOptions) {
    super()
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.buffer += chunk.toString()
    let newlineIndex = this.buffer.indexOf("\n")
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      this.pushFormatted(line)
      newlineIndex = this.buffer.indexOf("\n")
    }
    callback()
  }

  _flush(callback: () => void) {
    if (this.buffer.length > 0) {
      this.pushFormatted(this.buffer)
      this.buffer = ""
    }
    callback()
  }

  private pushFormatted(line: string) {
    if (!line.trim()) {
      return
    }

    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }

    const levelNumber = typeof entry.level === "number" ? entry.level : 30
    const levelLabel = LEVEL_LABELS[levelNumber] ?? "info"
    const component = (entry.component as string | undefined) ?? (entry.module as string | undefined) ?? "app"

    if (this.options.restrictInfoToLifecycle && levelNumber <= 30 && !LIFECYCLE_COMPONENTS.has(component)) {
      return
    }

    const message = typeof entry.msg === "string" ? entry.msg : ""
    const metadata = this.formatMetadata(entry)
    const formatted = metadata.length > 0 ? `[${levelLabel.toUpperCase()}] [${component}] ${message} ${metadata}` : `[${levelLabel.toUpperCase()}] [${component}] ${message}`
    this.push(`${formatted}\n`)
  }

  private formatMetadata(entry: Record<string, unknown>): string {
    const pairs: string[] = []
    for (const [key, value] of Object.entries(entry)) {
      if (OMITTED_FIELDS.has(key)) {
        continue
      }

      if (key === "err" && value && typeof value === "object") {
        const err = value as { type?: string; message?: string; stack?: string }
        const errLabel = err.type ?? "Error"
        const errMessage = err.message ? `: ${err.message}` : ""
        pairs.push(`err=${errLabel}${errMessage}`)
        if (err.stack) {
          pairs.push(`stack="${err.stack}"`)
        }
        continue
      }

      pairs.push(`${key}=${this.stringifyValue(value)}`)
    }

    return pairs.join(" ").trim()
  }

  private stringifyValue(value: unknown): string {
    if (value === undefined) return "undefined"
    if (value === null) return "null"
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (value instanceof Error) return value.message ?? value.name
    return JSON.stringify(value)
  }
}
