import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { NativeParent, NATIVE_REQUEST_PREFIX, NATIVE_RESPONSE_PREFIX } from "../native-parent"
import { registerAutomationPluginRoute } from "../server/routes/automation-plugin"
import { AUTOMATION_BRIDGE_PATH, createAutomationBridgeRegistration, createDeveloperToolTransform, publishAutomationBridge } from "./automation-plugin"

for (const outcome of ["lost", "refused", "invalid-ack", "null-ack", "redirect", "late-successor", "reused-incarnation"]) {
  const lost = outcome !== "refused"
  test(`restart acknowledgement: ${outcome}`, { timeout: 15_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "codenomad-restart-ack-"))
    const envKeys = ["LOCALAPPDATA", "XDG_RUNTIME_DIR", "WSL_DISTRO_NAME"] as const
    const previous = envKeys.map(key => process.env[key])
    process.env.LOCALAPPDATA = process.env.XDG_RUNTIME_DIR = root
    delete process.env.WSL_DISTRO_NAME
    const apps = new Map<string, ReturnType<typeof Fastify>>()
    const removals: Array<() => Promise<void>> = []
    t.after(async () => {
      envKeys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key]
        else process.env[key] = previous[i]
      })
      await Promise.all(removals.map(remove => remove()))
      await Promise.all([...apps.values()].map(app => app.close()))
      await rm(root, { recursive: true, force: true })
    })

    const scope = { nativeIdentity: "electron:test", windowId: "window-a" }
    const ready = (runId: string, windowId = scope.windowId) => ({
      ...scope, windowId, windowInstance: `${runId}-${windowId}`, runId, state: "ready", cdpUrl: "http://127.0.0.1:9222",
    })
    const nativeWindow = ({ windowId, windowInstance, runId }: ReturnType<typeof ready>) => ({ windowId, windowInstance, runId })
    const inventory = (status: ReturnType<typeof ready>) => ({
      status, windows: [{ ...nativeWindow(status), focused: true }],
    })
    const rendererCalls: string[] = []
    const successorStatus: unknown[] = []
    let successorInventory = 0
    async function bridge(port: number, nativeParent: unknown) {
      const app = Fastify()
      const registration = createAutomationBridgeRegistration(`http://127.0.0.1:${port}${AUTOMATION_BRIDGE_PATH}`)
      apps.set(registration.url, app)
      registerAutomationPluginRoute(app, {
        authManager: { isLoopbackRequest: () => true }, bridgeToken: registration.token, nativeParent,
        workspaceManager: {
          getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
          list: () => [{ id: "owner" }], ownsLocation: async () => true,
        },
        developerCdp: {
          context: async () => ({ windowId: scope.windowId }), close: () => undefined,
          probeContexts: async () => new Map(),
          inspect: async ({ runId, windowId, windowInstance }: ReturnType<typeof nativeWindow>, _options: unknown, hooks?: { beforeRead?: () => void }) => {
            hooks?.beforeRead?.()
            return {
              target: { id: "page", title: runId, url: "http://app.test" },
              context: { windowId, windowInstance, instanceId: null, sessionId: null },
              snapshot: "", collapsed: 0, diagnostics: [],
            }
          },
          act: async ({ windowId }: { windowId: string }) => { rendererCalls.push(`press ${windowId}`); return {} },
          screenshot: async ({ windowId }: { windowId: string }) => {
            rendererCalls.push(`screenshot ${windowId}`)
            return { data: "aW1hZ2U=", mediaType: "image/png" }
          },
        },
      } as never)
      removals.push(await publishAutomationBridge(registration))
    }

    const attempts: unknown[] = [], reconnects: unknown[] = []
    let replacement: Promise<void> | undefined
    const old = new NativeParent({ write: line => {
      const request = JSON.parse(String(line).slice(NATIVE_REQUEST_PREFIX.length))
      const reply = (outcome: object) => old.handleLine(NATIVE_RESPONSE_PREFIX + JSON.stringify({ v: 1, id: request.id, ...outcome }))
      if (request.method === "developer.status" || request.method === "developer.targets") {
        queueMicrotask(() => reply({ ok: true, result: inventory(ready("old")) }))
      } else {
        assert.equal(request.method, "developer.restartScope")
        attempts.push(request.params)
        replacement = bridge(11002, { request: async (method: string, params: { windowId?: string }) => {
          if (method === "developer.status") {
            successorStatus.push(params)
            return { status: ready("successor", params.windowId ?? "window-b") }
          }
          if (method === "developer.targets") {
            successorInventory++
            return inventory(ready("successor", "window-b"))
          }
          assert.equal(method, "developer.reconnect")
          reconnects.push(params)
          return { status: { ...ready("successor"), restartId: request.params.restartId } }
        } }).then(() => {
          if (lost) old.close()
          else reply({ ok: false, error: { code: "native_error", message: "Native parent is shutting down" } })
        })
      }
      return true
    } }, true)
    await bridge(11001, old)
    const status: number[] = []
    const redirectRules: Array<RequestRedirect | undefined> = []
    let originalOffline = false
    const clock = Date.now.bind(Date)
    let advance = 0
    t.mock.method(Date, "now", () => clock() + advance)
    t.mock.method(globalThis, "fetch", (async (url, init) => {
      const payload = JSON.parse(String(init?.body))
      if (originalOffline && new URL(String(url)).port === "11001") return new Response("{}", { status: 404 })
      const response = await apps.get(String(url))!.inject({
        method: "POST", url: new URL(String(url)).pathname, headers: init?.headers as Record<string, string>, payload,
      })
      if (payload.mode === "developer-restart") {
        status.push(response.statusCode)
        if (outcome === "invalid-ack") return new Response('{"result":null}')
        if (outcome === "null-ack") return new Response("null")
        if (outcome === "redirect") {
          redirectRules.push(init?.redirect)
          if (init?.redirect === "error") throw new TypeError("redirect disallowed")
          return new Response("{}", { status: 307, headers: { Location: "http://127.0.0.1:11002" } })
        }
      }
      if (payload.mode === "developer-reconnect" && response.statusCode === 200
        && (outcome === "late-successor" || outcome === "reused-incarnation")) {
        advance = 96_000
        const body = response.json()
        if (outcome === "reused-incarnation") {
          const windowInstance = ready("old").windowInstance
          body.developerTarget.windowInstance = windowInstance
          body.result.context.windowInstance = windowInstance
          advance = 0
          setImmediate(() => { advance = 96_000 })
        }
        return Response.json(body)
      }
      return new Response(response.body, { status: response.statusCode })
    }) satisfies typeof fetch)
    type Tool = { name: string; execute(input: unknown, context: { sessionID: string }): Promise<{ content: unknown }> }
    const collect = () => {
      const tools = new Map<string, Tool>()
      createDeveloperToolTransform()({ add: value => tools.set(value.name, value as Tool) })
      return tools
    }
    const tools = collect()
    const context = { sessionID: "session" }
    await tools.get("inspect")!.execute({}, context)
    const restart = tools.get("act")!.execute({ action: "restart" }, context)
    if (outcome === "late-successor" || outcome === "reused-incarnation") {
      await assert.rejects(restart, /could not be confirmed/)
      await assert.rejects(tools.get("screenshot")!.execute({}, context), /inspect/i)
      assert.equal(attempts.length, 1)
      return
    } else if (lost) assert.match(String((await restart).content), /successor/)
    else await assert.rejects(restart, /Native parent is shutting down/)
    await replacement
    assert.equal(attempts.length, 1)
    assert.deepEqual(reconnects, lost ? attempts : [])
    assert.deepEqual(status, [lost ? 502 : 409])
    if (outcome === "redirect") assert.deepEqual(redirectRules, ["error"])
    assert.equal(successorInventory, 0, "reconnect cannot use the focused window inventory")
    if (lost) {
      const press = (owner = tools) => owner.get("act")!.execute({ action: "press", key: "Enter" }, context)
      const capture = (owner = tools) => owner.get("screenshot")!.execute({}, context)
      await press()
      await capture()
      assert.deepEqual(rendererCalls, ["press window-a", "screenshot window-a"])
      assert.deepEqual(successorStatus, Array(4).fill(nativeWindow(ready("successor"))))

      // Another plugin setup inspects B after A's reconnect result has reached this one.
      originalOffline = true
      const inspectorB = collect()
      assert.match(String((await inspectorB.get("inspect")!.execute({}, context)).content), /CodeNomad window window-b/)
      await assert.rejects(press(), /inspect again/i)
      await assert.rejects(capture(), /inspect again/i)
      assert.deepEqual(rendererCalls, ["press window-a", "screenshot window-a"])
      assert.equal(successorStatus.length, 6, "the stale pin is rejected before asking the host")
      await press(inspectorB)
      await capture(inspectorB)
      assert.deepEqual(rendererCalls.slice(2), ["press window-b", "screenshot window-b"])
      assert.deepEqual(successorStatus.slice(-3), Array(3).fill(nativeWindow(ready("successor", "window-b"))))
    }
  })
}
