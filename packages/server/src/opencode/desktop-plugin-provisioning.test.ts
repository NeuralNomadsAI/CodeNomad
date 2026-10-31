import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import test from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import type { Endpoint } from "@opencode/client/service"
import { OpenCodeSharedService, type OpenCodeSharedServiceDependencies } from "../workspaces/opencode-service"
import { resolveDesktopPluginPaths } from "./desktop-plugin-paths"
import { provisionDesktopPlugins } from "./desktop-plugin-provisioning"
import { installDesktopPluginPresence } from "./desktop-plugin-installation"

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
    assert.deepEqual(calls.map(({ level }) => level), ["error"])
    assert(calls[0].message.startsWith(`${message}. `), calls[0].message)
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

test("a failure repeated by every reconnection is logged as an error once, until provisioning succeeds", async () => {
  const current = { assertCurrent() {} }
  const reported = new Set<string>()
  const { calls, logger } = recordingLogger()
  let failure: string | undefined = "Managed plugin bundle differs from its digest"
  const provision = () => provisionDesktopPlugins({ connection: current, logger, reported,
    resolvePaths: async () => ({ config: "/root" }),
    install: async () => { if (failure) throw new Error(failure) } })
  for (let attempt = 0; attempt < 8; attempt += 1) assert.equal(await provision(), false)
  failure = "another failure"
  assert.equal(await provision(), false)
  assert.deepEqual(calls.map(call => call.level), ["error", ...Array(7).fill("debug"), "error"])
  assert.match(calls[0].message, /cannot list questions and permissions that were already waiting/)
  failure = undefined
  assert.equal(await provision(), true)
  failure = "another failure"
  assert.equal(await provision(), false)
  assert.equal(calls.at(-1)?.level, "error", "a success re-arms the error")
})

test("a persistent filesystem failure naming a fresh lease or temporary file each time is still logged once", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-provisioning-failure-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reported = new Set<string>()
  const { calls, logger } = recordingLogger()
  // A real filesystem error, carrying a new generated name on every attempt, as lease writes do.
  const install = (directory: string) => async () => {
    await writeFile(path.join(root, directory, "presence", `${randomUUID()}.lease.${randomUUID()}.tmp`), "")
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await provisionDesktopPlugins({ connection: { assertCurrent() {} }, logger, reported,
      resolvePaths: async () => ({ config: root }), install: install("missing") }), false)
  }
  assert.deepEqual(calls.map(call => call.level), ["error", "debug", "debug"])
  assert.equal(reported.size, 1)
  assert.equal(await provisionDesktopPlugins({ connection: { assertCurrent() {} }, logger, reported,
    resolvePaths: async () => ({ config: root }), install: install("elsewhere") }), false)
  assert.equal(calls.at(-1)?.level, "error", "a failure at another destination is a different problem")

  // Directories named by UUIDs are stable destinations: only generated file names are masked.
  const first = randomUUID(), second = randomUUID()
  const levels = async (directory: string) => {
    const before = calls.length
    await provisionDesktopPlugins({ connection: { assertCurrent() {} }, logger, reported,
      resolvePaths: async () => ({ config: root }), install: install(directory) })
    return calls.slice(before).map(call => call.level)
  }
  assert.deepEqual([...await levels(first), ...await levels(second), ...await levels(first), ...await levels(second)],
    ["error", "error", "debug", "debug"])
})

for (const role of ["runtime", "provider"] as const) test(`Missions ${role} publication failures use shared recovery notices and re-arm after repair`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-provisioning-carrier-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const runtime = Buffer.from("runtime"), provider = Buffer.from("provider")
  const bytes = role === "runtime" ? runtime : provider
  const file = path.join(paths.data, "missions", `${createHash("sha256").update(bytes).digest("hex")}${role === "provider" ? ".provider" : ""}.mjs`)
  await mkdir(file, { recursive: true })
  await writeFile(path.join(file, "sentinel"), "keep")
  const { calls, logger } = recordingLogger(), reported = new Set<string>()
  const provision = () => provisionDesktopPlugins({ connection: { assertCurrent() {} }, logger, reported,
    resolvePaths: async () => paths,
    install: async resolved => {
      const stop = await installDesktopPluginPresence("missions", runtime, resolved, () => {}, () => "", provider)
      await stop()
    } })
  assert.equal(await provision(), false)
  assert.equal(await provision(), false)
  assert.deepEqual(calls.map(call => call.level), ["error", "debug"])
  assert.match(calls[0].message, /Missions and automation are unavailable/)
  assert.match(String(calls[0].err), /is a directory/)
  assert.equal(await readFile(path.join(file, "sentinel"), "utf8"), "keep")
  assert.equal((await readdir(path.join(paths.data, "missions", "presence"))).length, 0)
  // The owner clears the refused ordinary directory; the normal connection path retries.
  await rm(file, { recursive: true })
  assert.equal(await provision(), true)
  assert.deepEqual(await readFile(file), bytes)
  assert.equal(reported.size, 0)
  await rm(file)
  await mkdir(file)
  assert.equal(await provision(), false)
  assert.equal(calls.at(-1)?.level, "error")
})
