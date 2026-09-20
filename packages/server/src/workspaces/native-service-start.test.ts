import assert from "node:assert/strict"
import { test } from "node:test"
import { NativeParent, NATIVE_REQUEST_PREFIX, NATIVE_RESPONSE_PREFIX } from "../native-parent"
import { nativeServiceStarter } from "./native-service-start"
import { HostOpenCodeService } from "./host-opencode-service"
import { WslOpenCodeService } from "./wsl-opencode-service"

test("desktop start alone crosses the native bridge for host and WSL lifecycles", async () => {
  for (const kind of ["host", "wsl"]) {
    const requests: any[] = []
    const parent = new NativeParent({ write(line: string | Uint8Array) {
      const request = JSON.parse(String(line).slice(NATIVE_REQUEST_PREFIX.length))
      requests.push(request)
      queueMicrotask(() => parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({
        v: 1, id: request.id, ok: true, result: { stdout: "http://127.0.0.1:4321\n", stderr: "" },
      })}`))
      return true
    } }, true)
    const local: string[][] = []
    const deps = {
      startFile: nativeServiceStarter(parent),
      execFile: async (_file: string, args: string[]) => {
        local.push(args)
        return { stdout: args.at(-1) === "status" ? "stopped\n" : "password\n", stderr: "" }
      },
      fetch: async () => Response.json({ version: "fixture", pid: 42, urls: ["http://127.0.0.1:4321"] }),
      readRegistration: async () => undefined,
    }
    const startupEnvironment = { TEST_START_TOKEN: "test-token" }
    const service = kind === "host"
      ? new HostOpenCodeService({ binary: process.execPath, startupEnvironment }, deps)
      : new WslOpenCodeService({ distro: "fixture", binary: "/bin/opencode", startupEnvironment }, deps)
    assert.equal(await service.discover(), undefined)
    assert.equal((await service.ensure()).url, "http://127.0.0.1:4321")
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, "opencode.service.start")
    assert.deepEqual(requests[0].params.args.slice(-2), ["service", "start"])
    assert.equal(typeof requests[0].params.cwd, "string")
    assert.equal(local.length, 9)
    assert.equal(local[0].at(-1), "status")
    assert.equal(local.at(-1)?.at(-1), "password")
    assert.equal(local.some(args => args.at(-1) === "start"), false)
    if (kind === "host") {
      assert.equal(requests[0].params.env.TEST_START_TOKEN, "test-token")
      assert.equal(requests[0].params.env.OPENCODE_DB, undefined)
    } else {
      assert.ok(requests[0].params.args.includes("TEST_START_TOKEN=test-token"))
      assert.ok(!requests[0].params.args.includes("OPENCODE_DB=ignored"))
    }
    parent.close()
  }
  assert.equal(nativeServiceStarter(new NativeParent(undefined, false)), undefined)
})

test("a failed native start never falls back inside backend containment", async () => {
  const local: string[][] = []
  const service = new HostOpenCodeService({ binary: process.execPath }, {
    execFile: async (_file, args) => {
      local.push(args)
      return { stdout: "stopped\n", stderr: "" }
    },
    startFile: async () => { throw new Error("native host unavailable") },
    readRegistration: async () => undefined,
  })
  assert.equal(await service.discover(), undefined)
  await assert.rejects(service.ensure(), /OpenCode start failed/)
  assert.deepEqual(local, [...discovery, ...discovery])
})

const discovery = [["service", "status"], ["service", "get", "password"], ["debug", "paths", "state"], ["debug", "paths", "config"]]
