import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { createEffect, createRoot, createSignal } from "solid-js"
import { stopWindowsProcessTree } from "../../../server/src/process-tree"
import { ServerEvents } from "./server-events"
import type { WorkspaceEventPayload } from "../../../server/src/api-types"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const deadlineMs = 30_000

// Supervise only these private subprocesses. A deadline is a test failure, not
// successful cleanup: the imported application must release its own resources.
function run(args: string[]): Promise<{ code: number | null; signal: string | null; timedOut: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
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

test("applies messages in one frame in stream order and flushes before a disconnect", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const setTimer = t.mock.method(globalThis, "setTimeout")
  const clearTimer = t.mock.method(globalThis, "clearTimeout")
  const fallback = () => setTimer.mock.calls.filter(call => call.arguments[1] === 32).at(-1)?.result
  const assertCancelled = (timer: unknown) => {
    assert.notEqual(timer, undefined)
    assert.ok(clearTimer.mock.calls.some(call => call.arguments[0] === timer))
    assert.equal(scheduled, undefined)
  }
  let scheduled: FrameRequestCallback | undefined
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => { scheduled = callback; return 1 },
    cancelAnimationFrame: () => { scheduled = undefined },
    window: {},
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
  t.after(() => {
    events.dispose()
    Reflect.deleteProperty(globalThis, "requestAnimationFrame")
    Reflect.deleteProperty(globalThis, "cancelAnimationFrame")
    Reflect.deleteProperty(globalThis, "window")
  })
  const [received, record] = createSignal("")
  const publications: string[] = []
  createRoot(dispose => {
    t.after(dispose)
    createEffect(() => { publications.push(received()) })
  })
  events.on("*", event => record(previous => previous + (event as { fixture?: string }).fixture))
  const transport: string[] = []
  events.onTransportStatus(status => transport.push(`${received()}:${status}`))
  await events.start()
  const event = (fixture: string) => ({ type: "workspace.started", fixture }) as unknown as WorkspaceEventPayload
  emit(event("A"))
  const firstFrame = scheduled
  const firstTimer = fallback()
  emit(event("B"))
  assert.equal(scheduled, firstFrame)
  assert.deepEqual(publications, [""])
  firstFrame!(0)
  assert.deepEqual(publications, ["", "AB"])
  assertCancelled(firstTimer)
  emit(event("C"))
  t.mock.timers.tick(31)
  assert.equal(received(), "AB")
  t.mock.timers.tick(1)
  assert.equal(received(), "ABC")
  assert.equal(scheduled, undefined)
  emit(event("D"))
  const disconnectTimer = fallback()
  disconnect()
  assert.equal(transport.at(-1), "ABCD:disconnected")
  assertCancelled(disconnectTimer)
  events.restart("fixture reconnect")
  emit(event("E"))
  const disposeTimer = fallback()
  assert.notEqual(disposeTimer, disconnectTimer)
  events.dispose()
  assertCancelled(disposeTimer)
  t.mock.timers.tick(32)
  assert.equal(received(), "ABCD")
})
