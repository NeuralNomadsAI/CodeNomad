import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode-ai/client"

import { OpenCodeSharedService } from "./opencode-service"

describe("OpenCodeSharedService", () => {
  it("lazily ensures one authenticated service for concurrent callers", async () => {
    let ensureCalls = 0
    let makeCalls = 0
    const client = {
      location: { get: async () => ({
        directory: "/repo",
        workspaceID: "workspace-1",
        project: { id: "project-1", directory: "/repo", canonical: "/repo" },
      }) },
    } as unknown as OpenCodeClient
    const service = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => {
        ensureCalls += 1
        await new Promise<void>((resolve) => setImmediate(resolve))
        return { url: "http://127.0.0.1:4321", auth: { type: "basic", username: "user", password: "pass" } }
      },
      headers: () => ({ authorization: "Basic token" }),
      stop: async () => undefined,
      makeClient: (options) => {
        makeCalls += 1
        assert.equal(options.baseUrl, "http://127.0.0.1:4321")
        assert.deepEqual(options.headers, { authorization: "Basic token" })
        return client
      },
    })

    assert.equal(ensureCalls, 0)
    const [endpoint, resolvedClient, location] = await Promise.all([
      service.endpoint(),
      service.client(),
      service.validateLocation({ directory: "/repo" }),
    ])

    assert.equal(endpoint.url, "http://127.0.0.1:4321")
    assert.strictEqual(resolvedClient, client)
    assert.equal(location.workspaceID, "workspace-1")
    assert.deepEqual([ensureCalls, makeCalls], [1, 1])
  })

  it("uses the generated location, event, and eviction APIs", async () => {
    const calls: unknown[] = []
    const signal = new AbortController().signal
    const events = { async *[Symbol.asyncIterator]() { yield { type: "server.connected" } as never } }
    const client = {
      location: {
        get: async (...args: unknown[]) => {
          calls.push(["get", ...args])
          return { directory: "/repo", project: { id: "p", directory: "/repo", canonical: "/repo" } }
        },
      },
      event: { subscribe: (...args: unknown[]) => { calls.push(["subscribe", ...args]); return events } },
      debug: { location: { evict: async (...args: unknown[]) => { calls.push(["evict", ...args]) } } },
    } as unknown as OpenCodeClient
    const service = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => ({ url: "https://localhost:4321" }),
      headers: () => undefined,
      stop: async () => undefined,
      makeClient: () => client,
    })

    await service.validateLocation({ directory: "/repo", workspaceID: "ws" }, { signal })
    const subscribed = await service.subscribe({ signal })
    const iterator = subscribed[Symbol.asyncIterator]()
    assert.deepEqual(await iterator.next(), { value: { type: "server.connected" }, done: false })
    await iterator.return?.()
    await service.evict({ directory: "/repo", workspaceID: "ws" }, { signal })

    assert.deepEqual(calls, [
      ["get", { location: { directory: "/repo", workspace: "ws" } }, { signal }],
      ["subscribe", { signal }],
      ["evict", { location: { directory: "/repo", workspace: "ws" } }, { signal }],
    ])
  })

  it("rejects malformed endpoints and locations", async () => {
    const invalidEndpoint = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => ({ url: "file:///tmp/opencode" }),
      headers: () => undefined,
      stop: async () => undefined,
      makeClient: () => { throw new Error("client should not be created") },
    })
    await assert.rejects(invalidEndpoint.endpoint(), /Unsupported OpenCode service protocol/)

    const invalidLocation = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => ({ url: "http://localhost:4321" }),
      headers: () => undefined,
      stop: async () => undefined,
      makeClient: () => ({ location: { get: async () => ({ directory: "/repo" }) } }) as unknown as OpenCodeClient,
    })
    await assert.rejects(invalidLocation.validateLocation({ directory: "/repo" }), /invalid location/)
  })

  it("clears a failed ensure so the next caller can retry", async () => {
    let calls = 0
    const service = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => {
        calls += 1
        if (calls === 1) throw new Error("not started")
        return { url: "http://localhost:4321" }
      },
      headers: () => undefined,
      stop: async () => undefined,
      makeClient: () => ({} as OpenCodeClient),
    })

    await assert.rejects(service.endpoint(), /not started/)
    assert.equal((await service.endpoint()).url, "http://localhost:4321")
    assert.equal(calls, 2)
  })

  it("rediscovers after transport failure", async () => {
    let ensures = 0
    let gets = 0
    const endpoint = { url: "http://localhost:4321" }
    const service = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => {
        ensures += 1
        return endpoint
      },
      headers: () => undefined,
      stop: async () => undefined,
      makeClient: () => ({
        location: { get: async () => {
          gets += 1
          if (gets === 1) throw new TypeError("fetch failed")
          return { directory: "/repo", project: { id: "p", directory: "/repo", canonical: "/repo" } }
        } },
      }) as unknown as OpenCodeClient,
    })

    await assert.rejects(service.validateLocation({ directory: "/repo" }), /fetch failed/)
    await service.validateLocation({ directory: "/repo" })
    assert.equal(ensures, 2)
  })

  it("stops only when registration proves its contender won", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-service-"))
    const file = path.join(root, "service.json")
    const contenders = path.join(root, "contenders.txt")
    const previous = process.env.CODENOMAD_SERVICE_TEST
    const stopFiles: Array<string | undefined> = []
    const info = { id: "instance-1", url: "http://localhost:4321", pid: 1234, password: "secret" }
    const createService = (contenderPid: number) => new OpenCodeSharedService({
        discover: async () => ({ url: info.url, auth: { type: "basic", username: "opencode", password: info.password } }),
        ensure: async (options) => {
          assert.equal(process.env.CODENOMAD_SERVICE_TEST, "configured")
          options?.onStart?.("missing")
          await writeFile(contenders, `${contenderPid}\n`)
          await writeFile(file, JSON.stringify(info))
          return { url: info.url, auth: { type: "basic", username: "opencode", password: info.password } }
        },
        headers: () => undefined,
        stop: async (options) => { stopFiles.push(options?.file) },
        makeClient: () => ({} as OpenCodeClient),
      })

    try {
      const lost = createService(9999)
      await lost.endpoint({ file, environment: {
        CODENOMAD_SERVICE_TEST: "configured",
        CODENOMAD_SERVICE_CONTENDERS: contenders,
      } })
      assert.equal(process.env.CODENOMAD_SERVICE_TEST, previous)
      await lost.shutdown()
      assert.deepEqual(stopFiles, [])

      const won = createService(info.pid)
      await won.endpoint({ file, environment: {
        CODENOMAD_SERVICE_TEST: "configured",
        CODENOMAD_SERVICE_CONTENDERS: contenders,
      } })
      await won.shutdown()
      assert.deepEqual(stopFiles, [file])
    } finally {
      if (previous === undefined) delete process.env.CODENOMAD_SERVICE_TEST
      else process.env.CODENOMAD_SERVICE_TEST = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retains possible ownership after discovery failure and retries shutdown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-service-retry-"))
    const file = path.join(root, "service.json")
    const contenders = path.join(root, "contenders.txt")
    const info = { id: "instance-1", url: "http://localhost:4321", pid: 1234, password: "secret" }
    let stops = 0
    const service = new OpenCodeSharedService({
      discover: async () => ({ url: info.url, auth: { type: "basic", username: "opencode", password: info.password } }),
      ensure: async (options) => {
        options?.onStart?.("missing")
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(info))
        await writeFile(contenders, `${info.pid}\n`)
        return { url: info.url, auth: { type: "basic", username: "opencode", password: info.password } }
      },
      headers: () => undefined,
      stop: async () => { stops += 1 },
      makeClient: () => ({} as OpenCodeClient),
    })

    try {
      await service.endpoint({ file, environment: { CODENOMAD_SERVICE_CONTENDERS: contenders } })
      await rm(file)
      await service.shutdown()
      assert.equal(stops, 0)

      await writeFile(file, JSON.stringify({ ...info, id: "replacement", pid: 5678 }))
      await service.shutdown()
      assert.equal(stops, 0)

      await writeFile(file, JSON.stringify(info))
      await Promise.all([service.shutdown(), service.shutdown()])
      assert.equal(stops, 1)
      await service.shutdown()
      assert.equal(stops, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("lets only the CodeNomad whose contender won stop a concurrent service", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-service-election-"))
    const file = path.join(root, "service.json")
    const firstContenders = path.join(root, "first.txt")
    const secondContenders = path.join(root, "second.txt")
    const info = { id: "winner", url: "http://localhost:4321", pid: 2222, password: "secret" }
    const starts = deferred<void>()
    let ready = false
    let stops = 0
    const createService = (contenderFile: string, pid: number) => new OpenCodeSharedService({
      discover: async () => ready
        ? { url: info.url, auth: { type: "basic", username: "opencode", password: info.password } }
        : undefined,
      ensure: async (options) => {
        options?.onStart?.("missing")
        await writeFile(contenderFile, `${pid}\n`)
        await starts.promise
        return { url: info.url, auth: { type: "basic", username: "opencode", password: info.password } }
      },
      headers: () => undefined,
      stop: async () => { stops += 1 },
      makeClient: () => ({} as OpenCodeClient),
    })
    const first = createService(firstContenders, info.pid)
    const second = createService(secondContenders, 3333)

    try {
      const connections = [
        first.endpoint({ file, environment: { CODENOMAD_SERVICE_CONTENDERS: firstContenders } }),
        second.endpoint({ file, environment: { CODENOMAD_SERVICE_CONTENDERS: secondContenders } }),
      ]
      await Promise.all([readWhenPresent(firstContenders), readWhenPresent(secondContenders)])
      await writeFile(file, JSON.stringify(info))
      ready = true
      starts.resolve()
      await Promise.all(connections)

      await Promise.all([first.shutdown(), second.shutdown()])
      assert.equal(stops, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function readWhenPresent(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(file)
      return
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  throw new Error(`Timed out waiting for ${file}`)
}
