import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"
import { join } from "node:path"
import { DeveloperRunManager, type DeveloperRunManagerDependencies } from "./developer-run-manager"

class FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = new PassThrough()
  stderr = new PassThrough()

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

function readyFetch(url: string | URL | Request): Promise<Response> {
  return Promise.resolve(String(url).endsWith("/json/version")
    ? response({ Browser: "test" })
    : response([{ id: "page-1", title: "CodeNomad", type: "page", url: "http://app.test/", webSocketDebuggerUrl: "ws://debug/page" }]))
}

function harness(overrides: DeveloperRunManagerDependencies = {}) {
  const children: FakeChild[] = []
  const launches: Array<{ executablePath: string; args: string[]; options: any }> = []
  let nextPid = 100
  const dependencies: DeveloperRunManagerDependencies = {
    runId: () => "run-1",
    allocatePort: async () => 9223,
    fetch: readyFetch as typeof fetch,
    stopTree: async () => {},
    spawn: (executablePath, args, options) => {
      const child = new FakeChild(nextPid++)
      children.push(child)
      launches.push({ executablePath, args, options })
      return child
    },
    ...overrides,
  }
  return { manager: new DeveloperRunManager(dependencies), children, launches }
}

test("builds isolated Electron and Tauri debug launches", async () => {
  const electron = harness()
  await electron.manager.start({ target: "electron", executable: "electron.exe", tempRoot: "C:\\runs" })
  const electronLaunch = electron.launches[0]
  assert.equal(electronLaunch.executablePath, "electron.exe")
  assert.deepEqual(electronLaunch.args, [
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223",
    `--user-data-dir=${join("C:\\runs", "run-1")}`, "--enable-logging",
  ])
  assert.equal(electronLaunch.options.env.CODENOMAD_UPDATE_CHANNEL, "developer-automation-run-1")
  assert.equal(electronLaunch.options.env.CLI_CONFIG, join("C:\\runs", "run-1", "config.yaml"))
  assert.match(electronLaunch.options.env.NODE_OPTIONS, /--enable-source-maps/)

  const tauri = harness()
  await tauri.manager.start({ target: "tauri", executable: "tauri.exe", tempRoot: "C:\\runs" })
  const tauriLaunch = tauri.launches[0]
  assert.deepEqual(tauriLaunch.args, [])
  assert.equal(tauriLaunch.options.env.WEBVIEW2_USER_DATA_FOLDER, join("C:\\runs", "run-1", "webview2"))
  assert.equal(tauriLaunch.options.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223")
  assert.equal(tauriLaunch.options.env.RUST_BACKTRACE, "1")
})

test("polls version and target endpoints until a top-level page is ready", async () => {
  const requests: string[] = []
  let lists = 0
  const { manager } = harness({
    fetch: (async (url) => {
      requests.push(String(url))
      if (String(url).endsWith("/json/version")) return response({ Browser: "test" })
      lists += 1
      return response(lists === 1
        ? [{ id: "loading", title: "", type: "page", url: "tauri://localhost/loading.html", webSocketDebuggerUrl: "ws://loading" }]
        : [{ id: "ready", title: "CodeNomad", type: "page", url: "http://ready.test/", webSocketDebuggerUrl: "ws://ready" }])
    }) as typeof fetch,
  })

  const status = await manager.start({ target: "electron", executable: "electron.exe", timeoutMs: 1_000 })
  assert.equal(status.state, "ready")
  assert.equal(status.targetUrl, "http://ready.test/")
  assert.equal(status.targetId, "ready")
  assert.deepEqual(requests.slice(0, 2), ["http://127.0.0.1:9223/json/version", "http://127.0.0.1:9223/json/list"])
  assert.ok(requests.length >= 4)
})

test("stale process exits cannot overwrite a newer run", async () => {
  let id = 0
  const { manager, children } = harness({ runId: () => `run-${++id}` })
  await manager.start({ target: "electron", executable: "first.exe" })
  await manager.start({ target: "electron", executable: "second.exe" })

  children[0].emit("exit", 1, null)
  assert.equal(manager.status().state, "ready")
  assert.equal(manager.status().runId, "run-2")
})

test("restarts with the same run, profile, and CDP endpoint", async () => {
  let stops = 0
  const { manager, launches } = harness({ stopTree: async () => { stops += 1 } })
  const first = await manager.start({ target: "electron", executable: "first.exe", tempRoot: "C:\\runs" })
  const restarted = await manager.restart()

  assert.equal(stops, 1)
  assert.equal(restarted.runId, first.runId)
  assert.equal(restarted.profilePath, first.profilePath)
  assert.equal(restarted.cdpUrl, first.cdpUrl)
  assert.deepEqual(launches.map((launch) => launch.executablePath), ["first.exe", "first.exe"])
  assert.match(manager.logs().map((entry) => entry.message).join("\n"), /Restarting developer build/)
})

test("keeps only the latest 1000 stdout and stderr log lines", async () => {
  const { manager, children } = harness()
  await manager.start({ target: "electron", executable: "electron.exe" })
  children[0].stdout.write(Array.from({ length: 700 }, (_, index) => `out-${index}`).join("\n") + "\n")
  children[0].stderr.write(Array.from({ length: 400 }, (_, index) => `err-${index}`).join("\n") + "\n")

  const logs = manager.logs()
  assert.equal(logs.length, 1_000)
  assert.deepEqual(logs[0], { runId: "run-1", timestamp: logs[0].timestamp, stream: "stdout", message: "out-100" })
  assert.deepEqual(logs.at(-1), { runId: "run-1", timestamp: logs.at(-1)!.timestamp, stream: "stderr", message: "err-399" })
  logs.length = 0
  assert.equal(manager.logs().length, 1_000)
})

test("bounds output before a process emits a newline", async () => {
  const { manager, children } = harness()
  await manager.start({ target: "electron", executable: "electron.exe" })
  children[0].stdout.write("x".repeat(100_000))
  children[0].stdout.write("\n")

  const message = manager.logs().at(-1)!.message
  assert.equal(message.length, 512)
  assert.match(message, /\.\.\.$/)
})

test("serializes overlapping lifecycle operations", async () => {
  let releaseStop!: () => void
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
  let stops = 0
  const { manager, launches } = harness({ stopTree: async () => { stops += 1; await stopGate } })
  await manager.start({ target: "electron", executable: "first.exe" })

  const second = manager.start({ target: "electron", executable: "second.exe" })
  const third = manager.start({ target: "electron", executable: "third.exe" })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(launches.length, 1)
  assert.equal(stops, 1)
  releaseStop()
  await Promise.all([second, third])

  assert.deepEqual(launches.map((launch) => launch.executablePath), ["first.exe", "second.exe", "third.exe"])
  assert.equal(stops, 2)
  assert.equal(manager.status().state, "ready")
})
