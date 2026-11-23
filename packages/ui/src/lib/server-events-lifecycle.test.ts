import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { stopWindowsProcessTree } from "../../../server/src/process-tree"
import { ServerEvents } from "./server-events"
import type { WorkspaceEventPayload } from "../../../server/src/api-types"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const deadlineMs = 30_000

// Supervise only these private subprocesses. A deadline is a test failure, not
// successful cleanup: the imported application must release its own resources.
function run(args: string[]): Promise<{ code: number | null; signal: string | null; timedOut: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    // Node's parent test-child marker otherwise suppresses a nested --test
    // runner. This child owns its own runner; require its complete test count.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    const spawnedBy = new Date()
    let output = "", timedOut = false
    child.stdout.on("data", chunk => { output += chunk })
    child.stderr.on("data", chunk => { output += chunk })
    const timeout = setTimeout(() => {
      timedOut = true
      if (!child.pid) return
      if (process.platform === "win32") {
        void stopWindowsProcessTree(child.pid, spawnedBy)
      } else {
        process.kill(-child.pid, "SIGKILL")
      }
    }, deadlineMs)
    child.once("error", error => { clearTimeout(timeout); reject(error) })
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, timedOut, output })
    })
  })
}

function assertNaturalExit(result: Awaited<ReturnType<typeof run>>): void {
  assert.equal(result.timedOut, false, `private subprocess exceeded ${deadlineMs}ms; not a natural exit:\n${result.output}`)
  assert.equal(result.signal, null, result.output)
  assert.equal(result.code, 0, result.output)
}

test("importing the actual serverEvents singleton without a browser exits naturally", async () => {
  const module = new URL("./server-events.ts", import.meta.url).href
  const result = await run(["--conditions=browser", "--import", "tsx", "--input-type=module", "--eval",
    `await import(${JSON.stringify(module)}); console.log("serverEvents import complete")`,
  ])
  assert.match(result.output, /serverEvents import complete/)
  assertNaturalExit(result)
})

test("the actual eleven compaction store tests pass and exit naturally without force-exit", async () => {
  const result = await run(["--conditions=browser", "--import", "tsx", "--test", "--test-reporter=tap",
    "packages/ui/src/stores/opencode-compaction.test.ts",
  ])
  assertNaturalExit(result)
  assert.match(result.output, /^# tests 11$/m)
  assert.match(result.output, /^# pass 11$/m)
  assert.match(result.output, /^# fail 0$/m)
  assert.match(result.output, /^# cancelled 0$/m)
  assert.match(result.output, /^# skipped 0$/m)
})

test("applies messages in one frame in stream order and flushes before a disconnect", async t => {
  let scheduled: FrameRequestCallback | undefined
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => { scheduled = callback; return 1 },
    cancelAnimationFrame: () => { scheduled = undefined },
    window: {},
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, "requestAnimationFrame")
    Reflect.deleteProperty(globalThis, "cancelAnimationFrame")
    Reflect.deleteProperty(globalThis, "window")
  })
  let emit!: (event: WorkspaceEventPayload) => void
  let disconnect!: () => void
  const events = new ServerEvents({
    api: {
      connectEvents: (onEvent, onError) => {
        emit = onEvent
        disconnect = onError!
        return { close() {} } as EventSource
      },
      sendClientConnectionPong: async () => {},
    },
    auth: { onRestored: () => () => true, check: async () => {} },
  })
  t.after(() => events.dispose())
  const received: string[] = []
  events.on("*", event => received.push((event as { fixture?: string }).fixture!))
  events.onTransportStatus(status => received.push(status))
  await events.start()
  const event = (fixture: string) => ({ type: "workspace.started", fixture }) as unknown as WorkspaceEventPayload
  emit(event("A"))
  const firstFrame = scheduled
  emit(event("B"))
  assert.equal(scheduled, firstFrame)
  assert.deepEqual(received, [])
  firstFrame!(0)
  assert.deepEqual(received, ["A", "B"])
  emit(event("C"))
  disconnect()
  assert.deepEqual(received.slice(2, 4), ["C", "disconnected"])
})
