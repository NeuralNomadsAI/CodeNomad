import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { HostOpenCodeService, hostOpenCodeServiceIdentity } from "./host-opencode-service"
import type { OpenCodeCliServiceDependencies, ServiceExecOptions } from "./opencode-cli-service"
import { OPENCODE_V2_REQUIRED_ERROR_CODE } from "../api-types"
import { runtimeIdentity } from "../opencode/compatibility/runtime"

const url = "http://127.0.0.1:4321"

describe("HostOpenCodeService", () => {
  it("explicit restart stops through CLI and starts through the native-parent bridge", async () => {
    const calls: Array<{ file: string; args: string[]; options: ServiceExecOptions }> = []
    let delegated = 0
    const service = createService(calls, { FIXTURE: "startup" }, {
      startFile: async (file, args, options) => {
        delegated++
        calls.push({ file, args, options })
        assert.equal(options.env?.FIXTURE, "startup")
        return { stdout: `${url}\n`, stderr: "" }
      },
      fetch: async () => Response.json({ version: "2.0.11", pid: 123, urls: [url] }),
    })
    assert.equal(runtimeIdentity(await service.restart())?.version, "2.0.11")
    assert.equal(delegated, 1)
    assert.deepEqual(calls.map(call => call.args), [["service", "stop"], ["service", "start"], ["service", "get", "password"]])
    assert.equal(calls[0].options.env, undefined)
  })

  it("uses status, start, and password through buildSpawnSpec without a shell", async () => {
    const calls: Array<{ file: string; args: string[]; options: ServiceExecOptions }> = []
    const service = createService(calls, { PROVIDER_TOKEN: "secret", NODE_EXTRA_CA_CERTS: "/ca.pem" })

    assert.equal(await service.discover(), undefined)
    assert.deepEqual(await service.ensure(), {
      url,
      auth: { type: "basic", username: "opencode", password: "password" },
    })

    assert.deepEqual(calls.map(({ args }) => args), [
      ["service", "status"],
      ["service", "start"],
      ["service", "get", "password"],
    ])
    assert.equal(calls.every(({ options }) => options.shell === false), true)
    assert.equal(calls[0]?.options.env, undefined)
    assert.equal(calls[2]?.options.env, undefined)
    assert.equal(calls[1]?.options.env?.PROVIDER_TOKEN, "secret")
    assert.equal(calls[1]?.options.env?.NODE_EXTRA_CA_CERTS, "/ca.pem")
  })

  it("authenticates strict bounded status and rejects malformed output", async () => {
    let authorization: string | null = null
    const calls: Array<{ file: string; args: string[]; options: ServiceExecOptions }> = []
    const service = createService(calls, {}, {
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization")
        return Response.json({ version: "2.0.4", pid: 1, urls: [url] })
      },
      execFile: async (file, args, options) => {
        calls.push({ file, args, options })
        return { stdout: args[args.length - 1] === "password" ? "password\n" : `${url}\n`, stderr: "" }
      },
    })
    await service.discover()
    assert.equal(authorization, `Basic ${Buffer.from("opencode:password").toString("base64")}`)

    const malformed = createService([], {}, {
      execFile: async () => ({ stdout: `${url}\nhttp://127.0.0.1:4322\n`, stderr: "" }),
    })
    await assert.rejects(malformed.discover(), /multiline/)
  })

  it("connects to wildcard services through loopback", async () => {
    let statusUrl = ""
    const service = createService([], {}, {
      execFile: async (_file, args) => ({
        stdout: args[args.length - 1] === "password" ? "password\n" : "http://0.0.0.0:4321\n",
        stderr: "",
      }),
      fetch: async (input) => {
        statusUrl = String(input)
        return Response.json({ version: "2.0.4", pid: 1, urls: [url] })
      },
    })

    assert.equal((await service.discover())?.url, "http://127.0.0.1:4321/")
    assert.equal(statusUrl, "http://127.0.0.1:4321/api/status")
  })

  it("falls back on status 404 to authenticated V2 health for discovery and startup", async () => {
    for (const operation of ["discover", "ensure"] as const) {
      const requests: string[] = []
      let cancelled = false
      const service = createService([], {}, {
        execFile: async (_file, args) => ({ stdout: args.at(-1) === "password" ? "password\n" : `${url}\n`, stderr: "" }),
        fetch: async (input, init) => {
          requests.push(String(input))
          assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:password").toString("base64")}`)
          if (requests.length === 1) return new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 404 })
          return Response.json({ healthy: true, version: "2.0.0", pid: 123 })
        },
      })
      assert.equal((await service[operation]())?.url, url)
      assert.deepEqual(requests, [`${url}/api/status`, `${url}/api/health`])
      assert.equal(cancelled, true)
    }
  })

  it("discovers server.info by route presence for any version on discovery and startup", async () => {
    for (const operation of ["discover", "ensure"] as const) {
      for (const version of ["2.0.7", "future-release"]) {
        const requests: string[] = []
        let cancelled = 0
        const service = createService([], {}, {
          execFile: async (_file, args) => ({ stdout: args.at(-1) === "password" ? "password\n" : `${url}\n`, stderr: "" }),
          fetch: async (input, init) => {
            requests.push(String(input))
            assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:password").toString("base64")}`)
            assert.equal(init?.redirect, "error")
            return String(input).endsWith("/api/info")
              ? Response.json({ version, pid: 123, urls: [url], paths: { tmp: "/tmp/opencode" } })
              : new Response(new ReadableStream({ cancel() { cancelled++ } }), { status: 404 })
          },
        })
        const endpoint = await service[operation]()
        assert.equal(runtimeIdentity(endpoint!)?.discovery, "info")
        assert.deepEqual(requests, [`${url}/api/status`, `${url}/api/health`, `${url}/api/info`])
        assert.equal(cancelled, 2)
      }
    }
  })

  it("validates info responses and preserves the final probe deadline", async (context) => {
    for (const response of [
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 404 }),
      () => new Response(null, { status: 503 }),
      () => new Response("invalid JSON"),
      () => Response.json({ version: "2.0.7", pid: 123 }),
      () => Response.json({ version: "2.0.7", pid: -1, urls: [url] }),
      () => new Response(" ".repeat(64 * 1024 + 1)),
    ]) {
      const requests: string[] = []
      const service = createService([], {}, {
        fetch: async (input) => {
          requests.push(String(input))
          return requests.length < 3 ? new Response(null, { status: 404 }) : response()
        },
      })
      await assert.rejects(service.ensure())
      assert.deepEqual(requests, [`${url}/api/status`, `${url}/api/health`, `${url}/api/info`])
    }
    let now = 1000
    context.mock.method(Date, "now", () => now)
    const requests: string[] = []
    const service = createService([], {}, {
      fetch: async (input) => {
        requests.push(String(input))
        return new Response(new ReadableStream({ cancel() { if (requests.length === 2) now = 1500 } }), { status: 404 })
      },
    })
    await assert.rejects(service.ensure(1500), /timed out/)
    assert.deepEqual(requests, [`${url}/api/status`, `${url}/api/health`])
  })

  it("does not downgrade on authentication, server, transport or malformed status failures", async () => {
    for (const response of [
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 403 }),
      () => new Response(null, { status: 503 }),
      () => new Response("invalid JSON"),
      () => Response.json({ healthy: true, version: "2.0.3", pid: 123 }),
      () => { throw new Error("ECONNREFUSED") },
    ]) {
      const requests: string[] = []
      const service = createService([], {}, {
        fetch: async (input) => { requests.push(String(input)); return response() },
      })
      await assert.rejects(service.ensure())
      assert.deepEqual(requests, [`${url}/api/status`])
    }
  })

  it("does not give the fallback a fresh deadline", async (context) => {
    let now = 1000
    context.mock.method(Date, "now", () => now)
    const requests: string[] = []
    const service = createService([], {}, {
      fetch: async (input) => {
        requests.push(String(input))
        return new Response(new ReadableStream({ cancel() { now = 1500 } }), { status: 404 })
      },
    })
    await assert.rejects(service.ensure(1500), /timed out/)
    assert.deepEqual(requests, [`${url}/api/status`])
  })

  it("redacts startup environment values from failures and hashes identity", async () => {
    const secret = "DO_NOT_LEAK"
    const service = createService([], { TOKEN: secret }, {
      execFile: async (_file, args) => {
        if (args[args.length - 1] === "status") return { stdout: "stopped\n", stderr: "" }
        throw Object.assign(new Error(secret), { code: 7, stdout: secret, stderr: secret })
      },
    })
    await service.discover()
    await assert.rejects(service.ensure(), (error: Error) => {
      assert.match(error.message, /start failed \(exit code 7\)/)
      assert.equal(error.message.includes(secret), false)
      return true
    })

    const identity = hostOpenCodeServiceIdentity({
      binary: process.platform === "win32" ? String.raw`C:\tools\..\opencode.exe` : "/opt/../opencode",
      startupEnvironment: { TOKEN: secret },
    })
    assert.match(identity, /:env:[a-f0-9]{64}$/)
    assert.equal(identity.includes(secret), false)
  })

  it("reports an actionable compatibility error for an OpenCode V1 binary", async () => {
    const service = createService([], {}, {
      execFile: async () => {
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stdout: "",
          stderr: `Commands:\n  opencode completion\n  opencode [project] start opencode tui [default]\n`,
        })
      },
    })

    await assert.rejects(service.discover(), (error: Error) => {
      assert.match(error.message, new RegExp(OPENCODE_V2_REQUIRED_ERROR_CODE))
      assert.doesNotMatch(error.message, /Commands:/)
      return true
    })
  })

  it("recognizes legacy help even when a wrapper exits zero on stdout or stderr", async () => {
    for (const stream of ["stdout", "stderr"]) {
      const service = createService([], {}, {
        execFile: async () => ({ stdout: "", stderr: "", [stream]: "Commands:\n  opencode completion\n  opencode [project]\n" }),
      })
      await assert.rejects(service.discover(), new RegExp(`^Error: ${OPENCODE_V2_REQUIRED_ERROR_CODE}:`))
    }
  })
})

function createService(
  calls: Array<{ file: string; args: string[]; options: ServiceExecOptions }>,
  startupEnvironment: NodeJS.ProcessEnv,
  overrides: Partial<OpenCodeCliServiceDependencies> = {},
) {
  return new HostOpenCodeService({
    binary: process.execPath,
    startupEnvironment,
    timeoutMs: 500,
  }, {
    execFile: async (file, args, options) => {
      calls.push({ file, args, options })
      const command = args.join(" ")
      if (command === "service status") return { stdout: "stopped\n", stderr: "" }
      if (command === "service start") return { stdout: `${url}\n`, stderr: "" }
      return { stdout: "password\n", stderr: "" }
    },
    fetch: async () => Response.json({ version: "2.0.4", pid: 123, urls: [url] }),
    ...overrides,
  })
}
