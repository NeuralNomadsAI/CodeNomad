import assert from "node:assert/strict"
import { it } from "node:test"
import type { Endpoint } from "@opencode/client/service"
import { OpenCodeCliService } from "./opencode-cli-service"
import { runtimeIdentity } from "../opencode/compatibility/runtime"

for (const kind of ["status", "health", "info"] as const) {
  for (const observedAt of [1999, 2000, 2001]) {
    it(`checks the final ${kind} body at ${observedAt} against absolute expiry, not timer dispatch`, async context => {
      let now = 1000, count = 0, reached!: () => void, stream!: ReadableStreamDefaultController<Uint8Array>
      let observedEndpoint: Endpoint | undefined
      const bodyPending = new Promise<void>(resolve => { reached = resolve })
      const timers = new Set<object>(), delays: number[] = [], commands: string[] = [], requests: string[] = []
      const url = "http://127.0.0.1:61900", deadlineAt = 2000
      const body = JSON.stringify(kind === "health" ? { healthy: true, version: "2.0.22", pid: 1 }
        : { version: "2.0.22", pid: 1, urls: [] })
      context.mock.method(Date, "now", () => now)
      context.mock.method(globalThis, "setTimeout", ((_callback: unknown, delay: number) => {
        const timer = { delay }; timers.add(timer); delays.push(delay)
        if (++count === (kind === "status" ? 4 : kind === "health" ? 6 : 8)) reached()
        return timer
      }) as unknown as typeof setTimeout)
      context.mock.method(globalThis, "clearTimeout", (timer: unknown) => { timers.delete(timer as object) })
      try {
        const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }))
        const service = new OpenCodeCliService({ label: "Private", timeoutMs: 1000,
          command: args => ({ command: "C:/private/mock-opencode.exe", args, options: {} }),
          beforeHealth: async endpoint => { observedEndpoint = endpoint },
        }, {
          execFile: async (_file, args, options) => {
            commands.push(args.join(" ")); assert.equal(options.timeout, deadlineAt - now)
            now += 100
            return { stdout: args.at(-1) === "status" ? `${url}\n` : "private-password\n", stderr: "" }
          },
          readRegistration: async () => { throw new Error("No private registration read expected") },
          fetch: async (input, options) => {
            requests.push(new URL(String(input)).pathname)
            assert.equal(new Headers(options?.headers).get("authorization"), `Basic ${Buffer.from("opencode:private-password").toString("base64")}`)
            assert.equal(options?.redirect, "error")
            now += 100
            return requests.at(-1) === `/api/${kind}` ? response : new Response(null, { status: 404 })
          },
        })
        const pending = service.discover(deadlineAt)
        await bodyPending
        now = observedAt
        stream.enqueue(new TextEncoder().encode(body)); stream.close()
        if (observedAt < deadlineAt) {
          assert.equal(await pending, observedEndpoint)
          assert.deepEqual(runtimeIdentity(observedEndpoint!), { version: "2.0.22", pid: 1, discovery: kind, contract: {} })
        } else {
          await assert.rejects(pending, new RegExp(`invalid ${kind} response`))
          assert.equal(runtimeIdentity(observedEndpoint!), undefined)
        }
        assert.deepEqual(commands, ["service status", "service get password"])
        assert.deepEqual(requests, ["/api/status", ...(kind !== "status" ? ["/api/health"] : []), ...(kind === "info" ? ["/api/info"] : [])])
        assert.equal(timers.size, 0)
        assert.ok(delays.every(delay => delay > 0 && delay < 1000))
        context.diagnostic(JSON.stringify({ observedAt, deadlineAt, kind, bodyBytes: Buffer.byteLength(body), commands, requests,
          timerDelays: delays, timersRemaining: timers.size, runtimePublished: Boolean(runtimeIdentity(observedEndpoint!)) }))
      } finally { context.mock.restoreAll() }
    })
  }
}

it("checks the original absolute clock immediately before runtime publication after synchronous JSON parsing", async context => {
  let now = 1000, observedEndpoint: Endpoint | undefined
  const parse = JSON.parse
  context.mock.method(Date, "now", () => now)
  context.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => { const result = parse(...args); now = 2000; return result })
  try {
    const service = new OpenCodeCliService({ label: "Private", timeoutMs: 1000,
      command: args => ({ command: "C:/private/mock-opencode.exe", args, options: {} }),
      beforeHealth: async endpoint => { observedEndpoint = endpoint },
    }, {
      execFile: async (_file, args) => ({ stdout: args.at(-1) === "status" ? "http://127.0.0.1:61901\n" : "private-password\n", stderr: "" }),
      readRegistration: async () => { throw new Error("No private registration read expected") },
      fetch: async () => new Response('{"version":"2.0.22","pid":1,"urls":[]}'),
    })
    await assert.rejects(service.discover(2000), /timed out/)
    assert.equal(runtimeIdentity(observedEndpoint!), undefined)
  } finally { context.mock.restoreAll() }
})
