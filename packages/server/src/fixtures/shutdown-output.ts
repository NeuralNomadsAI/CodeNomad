import { createLogger } from "../logger"
import { createServerShutdownHandler, installShutdownSignalHandlers, installShutdownStdinHandler } from "../shutdown"

// Private child only: exercise the real logger/handler without starting a backend or OpenCode.
const logger = createLogger({ level: "info", destination: "stdout" })
const shutdown = createServerShutdownHandler({ logger, shutdown: async () => {
  const chunk = `${"x".repeat(4096)}\n`
  for (let index = 0; index < 128; index += 1) {
    logger.info({}, `drain-${index}`)
    for (const stream of [process.stdout, process.stderr]) {
      await new Promise<void>((resolve, reject) => stream.write(chunk, (error) => error ? reject(error) : resolve()))
    }
  }
  process.stdin.destroy()
} })
installShutdownSignalHandlers(process, shutdown)
installShutdownStdinHandler(process.stdin, shutdown)
console.log("READY")
