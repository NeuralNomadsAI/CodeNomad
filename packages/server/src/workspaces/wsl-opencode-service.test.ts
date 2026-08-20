import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  WslOpenCodeService,
  type WslOpenCodeServiceDependencies,
} from "./wsl-opencode-service"

type ExecCall = {
  file: string
  args: string[]
  options: Parameters<WslOpenCodeServiceDependencies["execFile"]>[2]
}

const url = "http://127.0.0.1:4321"

describe("WslOpenCodeService", () => {
  it("discovers stopped and running services with exact CLI arguments and no shell", async () => {
    const stopped = harness({ status: "stopped\n" })
    assert.equal(await stopped.service.discover(), undefined)
    assert.equal(stopped.calls.length, 1)
    assert.deepEqual(stopped.calls[0]?.args, [
      "--distribution", "Ubuntu", "--exec", "/home/dev/opencode2", "service", "status",
    ])

    const running = harness({ status: `${url}\n`, password: "secret\n" })
    assert.deepEqual(await running.service.discover(), {
      url,
      auth: { type: "basic", username: "opencode", password: "secret" },
    })
    assert.deepEqual(running.calls.map((call) => call.args.slice(4)), [
      ["service", "status"],
      ["service", "get", "password"],
    ])
    for (const call of running.calls) {
      assert.equal(call.file, "wsl.exe")
      assert.equal(call.options.shell, false)
      assert.equal(call.options.windowsHide, true)
      assert.equal(call.options.maxBuffer, 64 * 1024)
      assert.ok(call.options.timeout > 0 && call.options.timeout <= 500)
      assert.equal("cwd" in call.options, false)
    }
  })

  it("starts through the Linux CLI, fetches the password, and authenticates Windows health", async () => {
    let healthRequest: { url: string; authorization: string | null } | undefined
    const test = harness({ start: `${url}\r\n`, password: "start-secret\r\n" }, {
      fetch: async (input, init) => {
        healthRequest = {
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        }
        return Response.json({ healthy: true, version: "2.0.0", pid: 987654 })
      },
    })

    const endpoint = await test.service.ensure()

    assert.deepEqual(test.calls.map((call) => call.args.slice(4)), [
      ["service", "start"],
      ["service", "get", "password"],
    ])
    assert.deepEqual(healthRequest, {
      url: `${url}/api/health`,
      authorization: `Basic ${Buffer.from("opencode:start-secret").toString("base64")}`,
    })
    assert.deepEqual(endpoint, {
      url,
      auth: { type: "basic", username: "opencode", password: "start-secret" },
    })
    assert.equal("pid" in endpoint, false)
  })

  it("passes startup environment only through wsl --exec env for a missing service", async () => {
    const test = harness(
      { status: "stopped\n", start: `${url}\n`, password: "secret\n" },
      {},
      500,
      { PROVIDER_TOKEN: "value with spaces", NODE_EXTRA_CA_CERTS: "/ca.pem" },
    )

    assert.equal(await test.service.discover(), undefined)
    await test.service.ensure()
    assert.deepEqual(test.calls.map((call) => call.args), [
      ["--distribution", "Ubuntu", "--exec", "/home/dev/opencode2", "service", "status"],
      [
        "--distribution", "Ubuntu", "--exec", "env",
        "NODE_EXTRA_CA_CERTS=/ca.pem", "PROVIDER_TOKEN=value with spaces",
        "/home/dev/opencode2", "service", "start",
      ],
      ["--distribution", "Ubuntu", "--exec", "/home/dev/opencode2", "service", "get", "password"],
    ])
  })

  it("rejects malformed, multiline, non-loopback, and path-bearing service URLs", async () => {
    for (const invalid of [
      "not-a-url\n",
      `${url}\nhttp://127.0.0.1:4322\n`,
      "http://192.0.2.1:4321\n",
      `${url}/private\n`,
      `http://user:pass@127.0.0.1:4321\n`,
      `${url}?private=true\n`,
      `${url}#private\n`,
      ` ${url}\n`,
    ]) {
      await assert.rejects(harness({ status: invalid }).service.discover(), /invalid loopback URL|multiline|malformed/)
    }
  })

  it("rejects empty and multiline passwords", async () => {
    await assert.rejects(harness({ status: `${url}\n`, password: "\n" }).service.discover(), /empty password/)
    await assert.rejects(
      harness({ status: `${url}\n`, password: "first\nsecond\n" }).service.discover(),
      /multiline password/,
    )
  })

  it("fails closed with actionable forwarding or health failures", async () => {
    await assert.rejects(harness({ status: `${url}\n`, password: "secret\n" }, {
      fetch: async () => { throw new Error("ECONNREFUSED") },
    }).service.discover(), /Enable WSL localhost forwarding/)

    await assert.rejects(harness({ status: `${url}\n`, password: "secret\n" }, {
      fetch: async () => new Response(null, { status: 401 }),
    }).service.discover(), /authentication failed.*401/)

    await assert.rejects(harness({ status: `${url}\n`, password: "secret\n" }, {
      fetch: async () => new Response(null, { status: 503 }),
    }).service.discover(), /health check failed.*503/)

    await assert.rejects(harness({ status: `${url}\n`, password: "secret\n" }, {
      fetch: async () => Response.json({ healthy: false, pid: 12 }),
    }).service.discover(), /not API-compatible/)
  })

  it("requires the complete compatible health shape", async () => {
    for (const health of [
      { healthy: true, pid: 1 },
      { healthy: true, version: "", pid: 1 },
      { healthy: true, version: "   ", pid: 1 },
      { healthy: true, version: "2.0.0", pid: 0 },
      { healthy: true, version: "2.0.0", pid: 1.5 },
      { healthy: true, version: "2.0.0", pid: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await assert.rejects(harness({ status: `${url}\n`, password: "secret\n" }, {
        fetch: async () => Response.json(health),
      }).service.discover(), /not API-compatible/)
    }
  })

  it("streams at most 64 KiB of health data and cancels an oversized body", async () => {
    const valid = JSON.stringify({ healthy: true, version: "2.0.0", pid: 123 }).padEnd(64 * 1024, " ")
    await harness({ status: `${url}\n`, password: "secret\n" }, {
      fetch: async () => new Response(valid),
    }).service.discover()

    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
        controller.enqueue(new Uint8Array([1]))
      },
      cancel() { cancelled = true },
    })
    await assert.rejects(harness({ status: `${url}\n`, password: "secret\n" }, {
      fetch: async () => new Response(oversized),
    }).service.discover(), /invalid health response/)
    assert.equal(cancelled, true)
  })

  it("redacts every error field from password retrieval failures and timeouts", async () => {
    const secret = "PASSWORD_SENTINEL_DO_NOT_LEAK"
    const failure = Object.assign(new Error(secret), {
      name: secret,
      stack: secret,
      code: secret,
      stdout: secret,
      stderr: secret,
      cause: secret,
      signal: secret,
      cmd: secret,
    })
    const failed = harness({}, {
      execFile: async (_file, args) => {
        if (args.at(-1) === "status") return { stdout: `${url}\n`, stderr: "" }
        throw failure
      },
    })
    await assert.rejects(failed.service.discover(), (error: Error) => {
      assert.match(error.message, /password retrieval failed/)
      assert.equal(error.message.includes(secret), false)
      return true
    })

    const nonzero = harness({}, {
      execFile: async (_file, args) => {
        if (args.at(-1) === "status") return { stdout: `${url}\n`, stderr: "" }
        throw Object.assign(new Error(secret), { code: 7, stdout: secret, stderr: secret })
      },
    })
    await assert.rejects(nonzero.service.discover(), (error: Error) => {
      assert.match(error.message, /password retrieval failed \(exit code 7\)/)
      assert.equal(error.message.includes(secret), false)
      return true
    })

    const timeout = harness({}, {
      execFile: async (_file, args) => args.at(-1) === "status"
        ? { stdout: `${url}\n`, stderr: "" }
        : new Promise(() => {}),
    }, 15)
    await assert.rejects(timeout.service.discover(), (error: Error) => {
      assert.match(error.message, /password retrieval failed/)
      assert.equal(error.message.includes(secret), false)
      return true
    })
  })

  it("bounds shared deadlines and nonzero command errors", async () => {
    const commandTimeouts: number[] = []
    const shared = harness({}, {
      execFile: async (_file, args, options) => {
        commandTimeouts.push(options.timeout)
        if (args.at(-1) === "status") {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { stdout: `${url}\n`, stderr: "" }
        }
        return { stdout: "secret\n", stderr: "" }
      },
    }, 100)
    await shared.service.discover()
    assert.ok((commandTimeouts[1] ?? 100) < (commandTimeouts[0] ?? 0))

    const timeout = harness({}, {
      execFile: async () => new Promise(() => {}),
    }, 15)
    await assert.rejects(timeout.service.discover(), /timed out after 15ms/)

    const output = "x".repeat(100_000)
    const failure = Object.assign(new Error(output), { code: 7, stdout: output, stderr: output })
    const nonzero = harness({}, {
      execFile: async () => { throw failure },
    })
    await assert.rejects(nonzero.service.discover(), (error: Error) => {
      assert.match(error.message, /code 7/)
      assert.ok(error.message.length < 1_200)
      return true
    })
  })

  it("uses only status, start, and password service commands", async () => {
    const test = harness({ status: `${url}\n`, start: `${url}\n`, password: "secret\n" })
    await test.service.discover()
    await test.service.ensure()

    const tokens = test.calls.flatMap((call) => call.args)
    for (const prohibited of [
      "stop", "restart", "serve", "--service", "--port", "--state", "--db", "pid", "process.kill",
    ]) {
      assert.equal(tokens.includes(prohibited), false, prohibited)
    }
    assert.deepEqual(test.calls.map((call) => call.args.slice(4)), [
      ["service", "status"],
      ["service", "get", "password"],
      ["service", "start"],
      ["service", "get", "password"],
    ])
  })
})

function harness(
  output: Partial<Record<"status" | "start" | "password", string>>,
  overrides: Partial<WslOpenCodeServiceDependencies> = {},
  timeoutMs = 500,
  startupEnvironment: NodeJS.ProcessEnv = {},
) {
  const calls: ExecCall[] = []
  const dependencies: WslOpenCodeServiceDependencies = {
    execFile: async (file, args, options) => {
      calls.push({ file, args, options })
      const operation = args.at(-1)
      const key = operation === "status" || operation === "start" ? operation : "password"
      return { stdout: output[key] ?? "", stderr: "" }
    },
    fetch: async () => Response.json({ healthy: true, version: "2.0.0", pid: 123 }),
    ...overrides,
  }
  return {
    calls,
    service: new WslOpenCodeService({
      distro: "Ubuntu",
      binary: "/home/dev/opencode2",
      startupEnvironment,
      timeoutMs,
    }, dependencies),
  }
}
