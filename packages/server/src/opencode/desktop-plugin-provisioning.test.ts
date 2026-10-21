import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import type { Endpoint } from "@opencode/client/service"
import { OpenCodeSharedService, type OpenCodeSharedServiceDependencies } from "../workspaces/opencode-service"
import { resolveDesktopPluginPaths } from "./desktop-plugin-paths"
import { provisionDesktopPlugins } from "./desktop-plugin-provisioning"

function recordingLogger() {
  const calls: Array<{ level: "debug" | "error"; message: string; err: unknown }> = []
  const record = (level: "debug" | "error") => (fields: { err: unknown }, message: string) => { calls.push({ level, message, err: fields.err }) }
  return { calls, logger: { debug: record("debug"), error: record("error") } as never }
}

test("a connection replaced while its discovery read is in flight is superseded, not a provisioning error", async t => {
  // The daemon answers nothing: the read stays in flight until the connection is replaced.
  const held: ServerResponse[] = []
  let received!: () => void
  const requested = new Promise<void>(resolve => { received = resolve })
  const daemon = createServer((_request, response) => { held.push(response); received() })
  await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve))
  const endpoint: Endpoint = { url: `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`,
    auth: { type: "basic", username: "fixture", password: "fixture" } }
  // The client goes through the connection's real transport, as the generated client does.
  const makeClient: OpenCodeSharedServiceDependencies["makeClient"] = options => ({
    config: { get: async (_input: unknown, request?: { signal?: AbortSignal }) =>
      (await options.fetch!(new URL("/config", options.baseUrl), { signal: request?.signal })).json() },
  }) as unknown as OpenCodeClient
  const service = new OpenCodeSharedService({ headers: () => ({ authorization: "Basic fixture" }), makeClient })
  t.after(async () => {
    await service.shutdown()
    for (const response of held) response.destroy()
    await new Promise(resolve => daemon.close(resolve))
  })

  const { calls, logger } = recordingLogger()
  let provisioning!: Promise<boolean>
  const client = service.client({
    kind: "lifecycle", identity: "superseded-provisioning",
    lifecycle: { discover: async () => endpoint, ensure: async () => endpoint },
    prepareDesktopPlugins: (connection, deadlineAt) => provisioning = provisionDesktopPlugins({
      connection, logger,
      resolvePaths: () => resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: "fixture" }, deadlineAt),
      install: async () => assert.fail("a superseded connection never installs"),
    }),
  })
  const rejected = assert.rejects(client, /connection changed/)
  await requested
  service.invalidate()
  assert.equal(await provisioning, false)
  await rejected

  assert.deepEqual(calls.map(({ level, message }) => ({ level, message })),
    [{ level: "debug", message: "Bundled plugin provisioning was superseded by a newer OpenCode connection" }])
  // The same abort the issue's log shows, now reported as a supersession.
  // The server compiles against a library without `Error.cause`; read it structurally.
  const err = calls[0].err as { cause?: unknown }
  assert.match(String(err.cause ?? err), /aborted/i)
})

test("failures on the current connection are still errors, at each provisioning step", async () => {
  const current = { assertCurrent() {} }
  for (const [options, message] of [
    [{ resolvePaths: async () => { throw new Error("no discovery directory") }, install: async () => {} },
      "Cannot provision bundled plugins without the connected daemon's discovery directory"],
    [{ resolvePaths: async () => ({ config: "/root" }), install: async () => { throw new Error("install failed") } },
      "Failed to provision bundled desktop plugins for the current connection"],
  ] as const) {
    const { calls, logger } = recordingLogger()
    assert.equal(await provisionDesktopPlugins({ connection: current, logger, ...options }), false)
    assert.deepEqual(calls.map(({ level, message }) => ({ level, message })), [{ level: "error", message }])
  }

  const { calls, logger } = recordingLogger()
  const installed: unknown[] = []
  assert.equal(await provisionDesktopPlugins({ connection: current, logger,
    resolvePaths: async () => ({ config: "/root" }), install: async paths => { installed.push(paths) } }), true)
  assert.deepEqual(installed, [{ config: "/root" }])
  assert.deepEqual(calls, [])

  const replaced = { assertCurrent() { throw new Error("OpenCode connection changed; refresh before retrying") } }
  const late = recordingLogger()
  assert.equal(await provisionDesktopPlugins({ connection: replaced, logger: late.logger,
    resolvePaths: async () => ({ config: "/root" }), install: async () => { throw new Error("stale") } }), false)
  assert.deepEqual(late.calls.map(call => call.level), ["debug"], "an install cut short by a replacement is superseded too")
})
