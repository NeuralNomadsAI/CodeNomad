import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { HostOpenCodeService, hostOpenCodeServiceIdentity } from "./host-opencode-service"
import type { OpenCodeCliServiceDependencies, ServiceExecOptions } from "./opencode-cli-service"

const url = "http://127.0.0.1:4321"

describe("HostOpenCodeService", () => {
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

  it("authenticates strict bounded health and rejects malformed output", async () => {
    let authorization: string | null = null
    const calls: Array<{ file: string; args: string[]; options: ServiceExecOptions }> = []
    const service = createService(calls, {}, {
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization")
        return Response.json({ healthy: true, version: "2.0.0", pid: 1 })
      },
      execFile: async (file, args, options) => {
        calls.push({ file, args, options })
        return { stdout: args.at(-1) === "password" ? "password\n" : `${url}\n`, stderr: "" }
      },
    })
    await service.discover()
    assert.equal(authorization, `Basic ${Buffer.from("opencode:password").toString("base64")}`)

    const malformed = createService([], {}, {
      execFile: async () => ({ stdout: `${url}\nhttp://127.0.0.1:4322\n`, stderr: "" }),
    })
    await assert.rejects(malformed.discover(), /multiline/)
  })

  it("redacts startup environment values from failures and hashes identity", async () => {
    const secret = "DO_NOT_LEAK"
    const service = createService([], { TOKEN: secret }, {
      execFile: async (_file, args) => {
        if (args.at(-1) === "status") return { stdout: "stopped\n", stderr: "" }
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
    fetch: async () => Response.json({ healthy: true, version: "2.0.0", pid: 123 }),
    ...overrides,
  })
}
