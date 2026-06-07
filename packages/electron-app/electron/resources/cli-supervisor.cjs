#!/usr/bin/env node

const { spawn } = require("child_process")

const SHUTDOWN_GRACE_MS = 30_000

let child = null
let shutdownTimer = null

function log(message, error) {
  if (error) {
    console.error(`[cli-supervisor] ${message}`, error)
    return
  }
  console.log(`[cli-supervisor] ${message}`)
}

function clearShutdownTimer() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer)
    shutdownTimer = null
  }
}

function forwardStream(stream, target) {
  if (!stream) return
  stream.on("data", (chunk) => {
    target.write(chunk)
  })
}

function terminateChild(force) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  try {
    child.kill(force ? "SIGKILL" : "SIGTERM")
  } catch {
    // no-op
  }
}

function requestShutdown(force = false) {
  if (!child) {
    process.exit(force ? 1 : 0)
    return
  }

  terminateChild(force)
  if (force) {
    process.exit(1)
    return
  }

  clearShutdownTimer()
  shutdownTimer = setTimeout(() => {
    log(`shutdown timed out after ${SHUTDOWN_GRACE_MS}ms; forcing child termination`)
    terminateChild(true)
  }, SHUTDOWN_GRACE_MS)
  shutdownTimer.unref()
}

function installShutdownHandlers() {
  process.on("SIGTERM", () => requestShutdown(false))
  process.on("SIGINT", () => requestShutdown(false))
  process.on("disconnect", () => requestShutdown(false))
  process.on("uncaughtException", (error) => {
    log("uncaught exception", error)
    requestShutdown(true)
  })
  process.on("unhandledRejection", (error) => {
    log("unhandled rejection", error)
    requestShutdown(true)
  })
}

function parsePayload() {
  const raw = process.argv[2]
  if (!raw) {
    throw new Error("Supervisor payload is required")
  }

  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Supervisor payload must be an object")
  }
  if (typeof parsed.command !== "string" || parsed.command.trim().length === 0) {
    throw new Error("Supervisor payload command is required")
  }
  if (!Array.isArray(parsed.args) || !parsed.args.every((value) => typeof value === "string")) {
    throw new Error("Supervisor payload args must be a string array")
  }

  return {
    command: parsed.command,
    args: parsed.args,
    cwd: typeof parsed.cwd === "string" && parsed.cwd.trim().length > 0 ? parsed.cwd : process.cwd(),
  }
}

function main() {
  installShutdownHandlers()

  const payload = parsePayload()
  log(`launching shell command: ${payload.command} ${payload.args.join(" ")}`)

  child = spawn(payload.command, payload.args, {
    cwd: payload.cwd,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  })

  forwardStream(child.stdout, process.stdout)
  forwardStream(child.stderr, process.stderr)

  child.on("error", (error) => {
    log("failed to spawn shell command", error)
    process.exit(1)
  })

  child.on("exit", (code, signal) => {
    clearShutdownTimer()
    log(`child exited code=${code ?? ""} signal=${signal ?? ""}`)
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 0
    process.exit()
  })
}

main()
