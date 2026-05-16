import { onMount } from "solid-js"
import { runtimeEnv } from "./lib/runtime-env"
import { getPerf242ServerEventMetrics, resetPerf242ServerEventMetrics } from "./lib/server-events"
import { selectInstanceTab } from "./stores/app-tabs"
import { createInstance, instances } from "./stores/instances"
import {
  fetchSessions,
  getSessions,
  loadMessages,
  runShellCommand,
  setActiveParentSession,
  setActiveSession,
} from "./stores/sessions"

const benchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams()
const PERF242_BENCH_MODE = benchParams.get("mode") === "long" ? "long" : "short"
const PERF242_BENCH_FOLDER = import.meta.env.VITE_PERF242_BENCH_FOLDER || "D:\\CodeNomad"
const PERF242_BENCH_SESSION_ID =
  import.meta.env.VITE_PERF242_BENCH_SESSION_ID
  || "ses_21feb15b3ffeLz3uRModK4KKnG"
const PERF242_BENCH_BINARY = import.meta.env.VITE_PERF242_BENCH_BINARY || "opencode"
const PERF242_SHORT_COMMAND = `node -e "for (let i = 1; i <= 400; i += 1) console.log('line ' + i)"`
const PERF242_LONG_COMMAND = `powershell -NoProfile -Command Start-Sleep -Seconds 70`
const PERF242_BENCH_COMMAND =
  PERF242_BENCH_MODE === "long" ? PERF242_LONG_COMMAND : PERF242_SHORT_COMMAND

let perf242TransportBenchStarted = false

function waitForMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs))
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true
    await waitForMs(100)
  }
  return predicate()
}

async function emitPerf242Log(payload: Record<string, unknown>): Promise<void> {
  console.info("[perf242]", payload)
  try {
    await fetch("/api/perf-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
      keepalive: true,
    })
  } catch (error) {
    console.warn("[perf242] failed to emit server log", { host: runtimeEnv.host, error })
  }
}

export default function TransportBench() {
  onMount(() => {
    if (perf242TransportBenchStarted) return
    perf242TransportBenchStarted = true

    void (async () => {
      await emitPerf242Log({
        stage: "bench-init",
        host: runtimeEnv.host,
        folder: PERF242_BENCH_FOLDER,
        sessionId: PERF242_BENCH_SESSION_ID,
      })

      if (!PERF242_BENCH_SESSION_ID) {
        await emitPerf242Log({ stage: "bench-skipped", reason: "missing-session-id" })
        return
      }

      let instanceId = Array.from(instances().values()).find((instance) => instance.folder === PERF242_BENCH_FOLDER)?.id
      if (!instanceId) {
        await emitPerf242Log({ stage: "create-instance", folder: PERF242_BENCH_FOLDER, binary: PERF242_BENCH_BINARY })
        instanceId = await createInstance(PERF242_BENCH_FOLDER, PERF242_BENCH_BINARY)
      }

      selectInstanceTab(instanceId)
      await emitPerf242Log({ stage: "instance-ready", instanceId })
      await fetchSessions(instanceId)
      await emitPerf242Log({ stage: "sessions-fetched", instanceId, sessionCount: getSessions(instanceId).length })

      const targetSession = getSessions(instanceId).find((session) => session.id === PERF242_BENCH_SESSION_ID)
      if (!targetSession) {
        await emitPerf242Log({
          stage: "bench-error",
          reason: "session-not-found",
          instanceId,
          sessionId: PERF242_BENCH_SESSION_ID,
        })
        return
      }

      const parentSessionId = targetSession.parentId ?? targetSession.id
      setActiveParentSession(instanceId, parentSessionId)
      if (targetSession.id !== parentSessionId) {
        setActiveSession(instanceId, targetSession.id)
      }

      await emitPerf242Log({ stage: "session-selected", instanceId, sessionId: targetSession.id, parentSessionId })
      await loadMessages(instanceId, targetSession.id, { force: true })
      await emitPerf242Log({ stage: "messages-loaded", instanceId, sessionId: targetSession.id })
      await waitForMs(500)

      resetPerf242ServerEventMetrics()
      await emitPerf242Log({
        stage: "start",
        folder: PERF242_BENCH_FOLDER,
        sessionId: targetSession.id,
        transportType: (globalThis as any).__TRANSPORT_TYPE ?? "unknown",
        command: PERF242_BENCH_COMMAND,
      })

      const startedAt = performance.now()
      await runShellCommand(instanceId, targetSession.id, PERF242_BENCH_COMMAND)

      const sawWorking = await waitForCondition(() => {
        const session = getSessions(instanceId).find((value) => value.id === targetSession.id)
        return session?.status === "working"
      }, 10000)

      const reachedIdle = await waitForCondition(() => {
        const session = getSessions(instanceId).find((value) => value.id === targetSession.id)
        return sawWorking ? session?.status === "idle" : false
      }, PERF242_BENCH_MODE === "long" ? 180000 : 120000)

      await emitPerf242Log({
        stage: reachedIdle ? "complete" : "timeout",
        sessionId: targetSession.id,
        instanceId,
        transportType: (globalThis as any).__TRANSPORT_TYPE ?? "unknown",
        elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
        sawWorking,
        reachedIdle,
        metrics: getPerf242ServerEventMetrics(),
      })
    })().catch(async (error) => {
      await emitPerf242Log({
        stage: "error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      })
      throw error
    })
  })

  return null
}
