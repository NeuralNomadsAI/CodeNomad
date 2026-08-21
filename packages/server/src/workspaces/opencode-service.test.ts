import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode-ai/client"
import type { Endpoint } from "@opencode-ai/client/service"

import {
  OpenCodeSharedService,
  type OpenCodeServiceLifecycle,
  type OpenCodeSharedServiceDependencies,
  type OpenCodeSharedServiceOptions,
} from "./opencode-service"

const endpoint: Endpoint = {
  url: "http://127.0.0.1:4321",
  auth: { type: "basic", username: "opencode", password: "secret" },
}

describe("OpenCodeSharedService", () => {
  it("discovers or starts one pinned CLI lifecycle", async () => {
    let discoveries = 0
    let starts = 0
    let running = false
    const lifecycle: OpenCodeServiceLifecycle = {
      discover: async () => { discoveries += 1; return running ? endpoint : undefined },
      ensure: async () => { starts += 1; running = true; return endpoint },
    }
    const service = createService()
    const options = lifecycleOptions("host:test", lifecycle)

    await Promise.all([service.endpoint(options), service.client(options)])
    assert.equal(starts, 1)
    assert.equal(discoveries, 1)
    assert.equal(await service.endpoint(), endpoint)
    assert.equal(discoveries, 2)
  })

  it("uses one caller deadline for discovery and startup", async () => {
    const deadlines: Array<number | undefined> = []
    const lifecycle: OpenCodeServiceLifecycle = {
      discover: async (deadlineAt) => { deadlines.push(deadlineAt); return undefined },
      ensure: async (deadlineAt) => { deadlines.push(deadlineAt); return endpoint },
    }
    const service = createService()

    await service.endpoint(lifecycleOptions("host:deadline", lifecycle), { deadlineAt: 12345 })

    assert.deepEqual(deadlines, [12345, 12345])
  })

  it("requires configuration before discovery and rejects identity changes", async () => {
    const service = createService()
    await assert.rejects(service.endpoint(), /has not been configured/)
    await service.endpoint(lifecycleOptions("host:first", lifecycleFor(endpoint)))
    await assert.rejects(
      service.endpoint(lifecycleOptions("host:second", lifecycleFor(endpoint))),
      /identity cannot change/,
    )
    await service.shutdown()
    assert.equal(await service.endpoint(lifecycleOptions("host:second", lifecycleFor(endpoint))), endpoint)
  })

  it("releases an initial failed discovery or startup identity", async () => {
    for (const failure of ["discover", "ensure"] as const) {
      const service = createService()
      const lifecycle: OpenCodeServiceLifecycle = {
        discover: async () => {
          if (failure === "discover") throw new Error("discovery failed")
          return undefined
        },
        ensure: async () => { throw new Error("startup failed") },
      }

      await assert.rejects(service.endpoint(lifecycleOptions(`host:${failure}`, lifecycle)), /failed/)
      assert.equal(await service.endpoint(lifecycleOptions("host:retry", lifecycleFor(endpoint))), endpoint)
    }
  })

  it("retains its identity after a successful connection and transient reconnect failure", async () => {
    let discoveries = 0
    const service = createService()
    const options = lifecycleOptions("host:pinned", {
      discover: async () => {
        discoveries += 1
        if (discoveries === 1) return endpoint
        throw new Error("service unavailable")
      },
      ensure: async () => endpoint,
    })

    await service.endpoint(options)
    await assert.rejects(service.endpoint(), /service unavailable/)
    await assert.rejects(
      service.endpoint(lifecycleOptions("host:replacement", lifecycleFor(endpoint))),
      /identity cannot change/,
    )
  })

  it("keeps the first lifecycle object for equivalent identities", async () => {
    let firstCalls = 0
    let replacementCalls = 0
    const service = createService()
    await service.endpoint(lifecycleOptions("host:same", {
      discover: async () => { firstCalls += 1; return endpoint },
      ensure: async () => endpoint,
    }))
    await service.endpoint(lifecycleOptions("host:same", {
      discover: async () => { replacementCalls += 1; return endpoint },
      ensure: async () => endpoint,
    }))
    assert.equal(firstCalls, 2)
    assert.equal(replacementCalls, 0)
  })

  it("drops only local state on shutdown and fences a late startup", async () => {
    let resolveStart!: (value: Endpoint) => void
    let discoveries = 0
    const lifecycle: OpenCodeServiceLifecycle = {
      discover: async () => { discoveries += 1; return discoveries === 1 ? undefined : endpoint },
      ensure: async () => new Promise((resolve) => { resolveStart = resolve }),
    }
    const service = createService()
    const pending = service.endpoint(lifecycleOptions("host:test", lifecycle))
    await new Promise((resolve) => setImmediate(resolve))
    await service.shutdown()
    resolveStart(endpoint)
    assert.equal(await pending, endpoint)
    assert.equal(await service.endpoint(lifecycleOptions("host:test", lifecycle)), endpoint)
    assert.equal(discoveries, 2)
  })

  it("rejects non-loopback endpoints", async () => {
    const service = createService()
    await assert.rejects(service.endpoint(lifecycleOptions("host:test", lifecycleFor({
      url: "http://192.0.2.1:4321",
      auth: undefined,
    }))), /must be loopback/)
  })

  it("normalizes wildcard lifecycle endpoints", async () => {
    let baseUrl = ""
    const service = createService({
      makeClient: (options) => {
        baseUrl = options.baseUrl
        return {} as OpenCodeClient
      },
    })
    const wildcard = { ...endpoint, url: "http://0.0.0.0:4321" }

    assert.equal((await service.endpoint(lifecycleOptions("host:wildcard", lifecycleFor(wildcard)))).url, "http://127.0.0.1:4321/")
    assert.equal(baseUrl, "http://127.0.0.1:4321/")
  })

  it("formats auth, validates locations, and evicts through the official debug API", async () => {
    let clientHeaders: HeadersInit | undefined
    let evicted: unknown
    let evictionSignal: AbortSignal | undefined
    const service = createService({
      makeClient: (options) => {
        clientHeaders = options.headers
        return {
          location: { get: async () => ({
            directory: "/repo",
            workspaceID: "canonical",
            project: { id: "project", directory: "/repo", canonical: "/repo" },
          }) },
          debug: { location: { evict: async (input: unknown, request?: { signal?: AbortSignal }) => {
            evicted = input
            evictionSignal = request?.signal
          } } },
        } as unknown as OpenCodeClient
      },
    })
    const options = lifecycleOptions("host:test", lifecycleFor(endpoint))
    const signal = new AbortController().signal

    assert.deepEqual(await service.headers(options), { authorization: "Basic proxy" })
    await assert.rejects(
      service.validateLocation({ directory: "/repo", workspaceID: "foreign" }, undefined, options),
      /does not match/,
    )
    await service.evictLocation(
      { directory: "/repo", workspaceID: "canonical" },
      { signal },
      options,
    )

    assert.deepEqual(clientHeaders, { authorization: "Basic proxy" })
    assert.deepEqual(evicted, { location: { directory: "/repo", workspace: "canonical" } })
    assert.equal(evictionSignal, signal)
  })
})

function lifecycleOptions(identity: string, lifecycle: OpenCodeServiceLifecycle): OpenCodeSharedServiceOptions {
  return { kind: "lifecycle", identity, lifecycle }
}

function lifecycleFor(value: Endpoint): OpenCodeServiceLifecycle {
  return { discover: async () => value, ensure: async () => value }
}

function createService(overrides: Partial<OpenCodeSharedServiceDependencies> = {}) {
  return new OpenCodeSharedService({
    headers: () => ({ authorization: "Basic proxy" }),
    makeClient: () => ({} as OpenCodeClient),
    ...overrides,
  })
}
