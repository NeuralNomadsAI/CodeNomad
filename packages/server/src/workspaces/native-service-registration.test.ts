import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { readNativeServiceRegistration, wslServiceMetadataPath } from "./native-service-registration"
import { HostOpenCodeService } from "./host-opencode-service"
import { WslOpenCodeService } from "./wsl-opencode-service"
import { runtimeIdentity } from "../opencode/compatibility/runtime"

const url = "http://127.0.0.1:4321"
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) })

test("native channel selection reads only credential-matched service metadata, rejects ambiguous or malformed registrations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-registration-"))
  const stateDirectory = path.join(root, "state"), configDirectory = path.join(root, "config")
  await mkdir(stateDirectory); await mkdir(configDirectory)
  const read = () => readNativeServiceRegistration({ stateDirectory, configDirectory, password: "selected" })
  const config = (name: string, value: unknown) => writeFile(path.join(configDirectory, name), JSON.stringify(value))
  const registration = (value: unknown) => writeFile(path.join(stateDirectory, "service-local.json"), JSON.stringify(value))
  try {
    await config("service.json", { password: "other" })
    await config("service-local.json", { password: "selected" })
    assert.equal(await read(), undefined, "no guessed stable/default port")
    await registration({ url, pid: 7, password: "selected" })
    assert.deepEqual(await read(), { url, pid: 7 })
    await config("service-another.json", { password: "selected" })
    await assert.rejects(read(), /uniquely identify/)
    await rm(path.join(configDirectory, "service-another.json"))
    for (const value of [{ url, pid: 0, password: "selected" }, { url, pid: 7, password: "wrong" }, [], "secret"] ) {
      await registration(value)
      await assert.rejects(read(), /Invalid native service/)
    }
    await writeFile(path.join(stateDirectory, "service-local.json"), "x".repeat(65537))
    await assert.rejects(read(), /Invalid native service metadata/)
    await rm(path.join(stateDirectory, "service-local.json"))
    await config("service-local.json", { password: "selected", hostname: "::1", port: 1234 })
    assert.deepEqual(await read(), { url: "http://[::1]:1234" })
    await config("service-local.json", { password: "selected", hostname: "127.0.0.2", port: 1234 })
    assert.deepEqual(await read(), { url: "http://127.0.0.2:1234" })
    let starts = 0, probes = 0
    const alternateLoopback = "http://127.0.0.2:1234"
    const service = new HostOpenCodeService({ binary: process.execPath, timeoutMs: 1000 }, {
      execFile: async (_file, args) => {
        const operation = args.join(" ")
        if (operation === "service start") { starts++; return { stdout: alternateLoopback, stderr: "" } }
        return { stdout: operation === "service status" ? "stopped" : operation === "debug paths state" ? stateDirectory
          : operation === "debug paths config" ? configDirectory : "selected", stderr: "" }
      },
      fetch: async input => {
        assert.equal(String(input), `${alternateLoopback}/api/status`)
        if (++probes === 1) throw refused()
        return Response.json({ version: "2.0.11", pid: 8, urls: [alternateLoopback] })
      },
    })
    assert.equal((await service.ensure()).url, alternateLoopback)
    assert.equal(starts, 1, "native config-only 127/8 loopback must permit stopped-service startup")
    for (const hostname of ["192.0.2.1", "127.0.0.2/path", "127.0.0.2@localhost", "127.0.0.2\n", "localhost?x"]) {
      await config("service-local.json", { password: "selected", hostname, port: 1234 })
      await assert.rejects(read())
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("WSL metadata resolves mounted aliases through the selected distro, with no traversal or shell interpretation", async () => {
  const calls: unknown[] = []
  assert.equal(await wslServiceMetadataPath("Ubuntu", "/home/alias", Date.now() + 1000, async (distro, command, args) => {
    calls.push({ distro, command, args })
    return command === "realpath" ? "/mnt/c/fixture/config\n" : "C:\\fixture\\config\n"
  }), "C:\\fixture\\config")
  assert.deepEqual(calls, [{ distro: "Ubuntu", command: "realpath", args: ["-m", "--", "/home/alias"] },
    { distro: "Ubuntu", command: "wslpath", args: ["-aw", "/mnt/c/fixture/config"] }])
  for (const value of ["relative", "/../../etc", "/home/../other", "/home\\other", "/a\nb"]) await assert.rejects(wslServiceMetadataPath("Ubuntu", value, Date.now() + 1000))
  await assert.rejects(wslServiceMetadataPath("Ubuntu/other", "/home", Date.now() + 1000))
})

function harness(input: { wsl?: boolean; registration?: boolean; configOnly?: boolean; fetch?: typeof fetch; hangRead?: boolean; timeout?: number } = {}) {
  const commands: string[][] = []
  let starts = 0, registrationReads = 0
  const dependencies = {
    execFile: async (_file: string, args: string[]) => {
      const command = input.wsl ? args.slice(4) : args
      commands.push(command)
      const operation = command.join(" ")
      if (operation === "service start") { starts++; return { stdout: url, stderr: "" } }
      return { stdout: operation === "service status" ? "stopped" : operation === "service get password" ? "selected" : "/native/root", stderr: "" }
    },
    readRegistration: async (options: Parameters<typeof readNativeServiceRegistration>[0]) => {
      registrationReads++
      if (input.wsl) assert.equal(typeof options.mapPath, "function")
      if (input.hangRead) return new Promise<never>(() => {})
      return input.registration === false ? undefined : input.configOnly ? { url } : { url, pid: 7 }
    },
    fetch: input.fetch ?? (async () => Response.json({ version: "2.0.3", pid: 7, urls: [url] })),
  }
  const options = { binary: process.execPath, timeoutMs: input.timeout ?? 500 }
  const service = input.wsl ? new WslOpenCodeService({ ...options, distro: "Ubuntu" }, dependencies) : new HostOpenCodeService(options, dependencies)
  return { service, commands, starts: () => starts, registrationReads: () => registrationReads }
}

test("stopped from the new CLI still authenticates old daemon on host and WSL, including ensure rediscovery", async () => {
  for (const wsl of [false, true]) {
    const requests: string[] = []
    const fixture = harness({ wsl, fetch: async (input, init) => {
      requests.push(String(input))
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:selected").toString("base64")}`)
      assert.equal(init?.redirect, "error")
      return String(input).endsWith("/api/status") ? new Response(null, { status: 404 }) : Response.json({ healthy: true, version: "2.0.3", pid: 7 })
    } })
    assert.equal(runtimeIdentity((await fixture.service.discover())!)?.version, "2.0.3")
    assert.equal(runtimeIdentity(await fixture.service.ensure())?.version, "2.0.3")
    assert.equal(fixture.starts(), 0)
    assert.equal(fixture.registrationReads(), 2)
    assert.deepEqual(requests, [`${url}/api/status`, `${url}/api/health`, `${url}/api/status`, `${url}/api/health`])
  }
})

test("only absent records or refused sockets allow start; errors and occupied incompatible listeners fail closed", async () => {
  const absent = harness({ registration: false })
  await absent.service.ensure()
  assert.equal(absent.starts(), 1)
  let attempts = 0
  const stale = harness({ fetch: async () => {
    if (++attempts === 1) throw refused()
    return Response.json({ version: "2.0.11", pid: 8, urls: [url] })
  } })
  await stale.service.ensure()
  assert.equal(stale.starts(), 1)
  for (const response of [
    async () => new Response(null, { status: 401 }),
    async () => new Response(null, { status: 404 }),
    async () => new Response(null, { status: 503 }),
    async () => new Response("{invalid"),
    async () => Response.json({ version: "2.0.11", pid: 8, urls: [url] }),
    async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }) },
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const fixture = harness({ fetch: response, timeout: 30 })
    await assert.rejects(fixture.service.ensure())
    assert.equal(fixture.starts(), 0)
  }
  const hungRead = harness({ hangRead: true, timeout: 20 })
  await assert.rejects(hungRead.service.ensure(), /timed out/)
  assert.equal(hungRead.starts(), 0)
  const wsl = harness({ wsl: true, fetch: async () => { throw refused() } })
  await assert.rejects(wsl.service.ensure(), /WSL localhost forwarding/)
  assert.equal(wsl.starts(), 0, "Windows refusal cannot establish Linux daemon absence")
  let probes = 0
  const freshWsl = harness({ wsl: true, configOnly: true, fetch: async () => {
    if (++probes === 1) throw refused()
    return Response.json({ version: "2.0.11", pid: 8, urls: [url] })
  } })
  await freshWsl.service.ensure()
  assert.equal(freshWsl.starts(), 1, "native registration ENOENT permits first start at an unoccupied configured port")
  for (const response of [new Response(null, { status: 401 }), new Response("foreign listener")]) {
    const occupiedWsl = harness({ wsl: true, configOnly: true, fetch: async () => response })
    await assert.rejects(occupiedWsl.service.ensure())
    assert.equal(occupiedWsl.starts(), 0, "registration absence does not admit an occupied incompatible endpoint")
  }
})

test("ensure rediscovers a daemon that appeared after an earlier absent discovery", async () => {
  let reads = 0, starts = 0
  const service = new HostOpenCodeService({ binary: process.execPath, timeoutMs: 500 }, {
    execFile: async (_file, args) => {
      if (args.at(-1) === "start") starts++
      return { stdout: args.at(-1) === "status" ? "stopped" : "selected", stderr: "" }
    },
    readRegistration: async () => ++reads === 1 ? undefined : { url, pid: 7 },
    fetch: async () => Response.json({ version: "2.0.3", pid: 7, urls: [url] }),
  })
  assert.equal(await service.discover(), undefined)
  assert.equal(runtimeIdentity(await service.ensure())?.version, "2.0.3")
  assert.equal(starts, 0)
})
