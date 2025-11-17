import pino, { Logger as PinoLogger } from "pino"

export type Logger = PinoLogger

interface LoggerOptions {
  level?: string
  destination?: string
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = (options.level ?? process.env.CLI_LOG_LEVEL ?? "info").toLowerCase()
  const destination = options.destination ?? process.env.CLI_LOG_DESTINATION ?? "stdout"

  if (destination && destination !== "stdout") {
    const stream = pino.destination({ dest: destination, mkdir: true, sync: false })
    return pino({ level }, stream)
  }

  return pino({ level })
}
