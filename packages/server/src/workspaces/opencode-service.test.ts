import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode-ai/client"
import type { Endpoint, Info } from "@opencode-ai/client/service"

import { OpenCodeSharedService, type OpenCodeEnsureOptions } from "./opencode-service"
import type { ProcessIdentity, ProcessIdentityProbe, ProcessNamespace } from "./process-identity"

describe("OpenCodeSharedService", () => {
  it("lazily ensures one authenticated service for concurrent callers", async () => {
    let ensureCalls = 0
    let makeCalls = 0
    const discoveryVersions: unknown[] = []
    const ensureVersions: unknown[] = []
    const client = {
      location: { get: async () => ({
        directory: "/repo",
        workspaceID: "workspace-1",
        project: { id: "project-1", directory: "/repo", canonical: "/repo" },
      }) },
    } as unknown as OpenCodeClient
    const service = new OpenCodeSharedService({
      discover: async (options) => {
        discoveryVersions.push(options?.version)
        return undefined
      },
      ensure: async (options) => {
        ensureCalls += 1
        ensureVersions.push(options?.version)
        await new Promise<void>((resolve) => setImmediate(resolve))
        return { url: "http://127.0.0.1:4321", auth: { type: "basic", username: "user", password: "pass" } }
      },
      headers: () => ({ authorization: "Basic token" }),
      makeClient: (options) => {
        makeCalls += 1
        assert.equal(options.baseUrl, "http://127.0.0.1:4321")
        assert.deepEqual(options.headers, { authorization: "Basic token" })
        return client
      },
    })

    assert.equal(ensureCalls, 0)
    const [endpoint, resolvedClient, location] = await Promise.all([
      service.endpoint({ version: "0.0.0-next-17353" }),
      service.client(),
      service.validateLocation({ directory: "/repo" }),
    ])

    assert.equal(endpoint.url, "http://127.0.0.1:4321")
    assert.strictEqual(resolvedClient, client)
    assert.equal(location.workspaceID, "workspace-1")
    assert.deepEqual([ensureCalls, makeCalls], [1, 1])
    assert.deepEqual(discoveryVersions, [])
    assert.deepEqual(ensureVersions, ["0.0.0-next-17353"])
  })

  it("uses the required version when rediscovering a connected service", async () => {
    const versions: unknown[] = []
    const endpoint = { url: "http://127.0.0.1:4321", auth: undefined }
    const service = new OpenCodeSharedService({
      discover: async (options) => {
        versions.push(options?.version)
        return endpoint
      },
      ensure: async () => endpoint,
      headers: () => undefined,
      makeClient: () => ({} as OpenCodeClient),
    })

    await service.endpoint({ version: "0.0.0-next-17353" })
    await service.endpoint()

    assert.deepEqual(versions, ["0.0.0-next-17353"])
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
      makeClient: () => { throw new Error("client should not be created") },
    })
    await assert.rejects(invalidEndpoint.endpoint(), /Unsupported OpenCode service protocol/)

    const remoteEndpoint = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => ({ url: "http://192.0.2.1:4321" }),
      headers: () => undefined,
      makeClient: () => { throw new Error("client should not be created") },
    })
    await assert.rejects(remoteEndpoint.endpoint(), /must be loopback/)

    const invalidLocation = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => ({ url: "http://localhost:4321" }),
      headers: () => undefined,
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

  it("persists native PID proof through transfer and shutdown reconstruction", async () => {
    const state = await serviceState("codenomad-service-peer-")
    let stops = 0
    const owner = createOwnedService(state, async () => { stops += 1; return true })
    const peer = createOwnedService(
      state,
      async () => { stops += 1; return true },
      false,
      (pid) => pid !== state.info.pid,
      undefined,
      true,
    )
    try {
      await owner.endpoint(state.options("owner", true))
      assert.equal(JSON.parse(await readFile(state.lease("owner"), "utf8")).service.nativePid, true)
      await peer.endpoint(state.options("peer", false))
      await owner.shutdown()
      assert.equal(stops, 0)
      assert.equal(JSON.parse(await readFile(state.lease("peer"), "utf8")).service.nativePid, true)
      assert.equal((await peer.endpoint()).url, state.info.url)
      await peer.shutdown()
      assert.equal(stops, 1)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("reclaims a bounded stale lifecycle lock after PID reuse", async () => {
    const state = await serviceState("codenomad-service-stale-lock-")
    const stalePid = 7654321
    await mkdir(state.lockDirectory)
    await writeFile(path.join(state.lockDirectory, "owner.json"), JSON.stringify({
      version: 1,
      identity: "stale-lock-owner",
      pid: stalePid,
      processIdentity: processIdentity(stalePid, "previous-process"),
      createdAt: 1,
    }))
    await Promise.all([
      utimes(path.join(state.lockDirectory, "owner.json"), 1, 1),
      utimes(state.lockDirectory, 1, 1),
    ])
    const service = createOwnedService(state, async () => true, true, () => true)
    try {
      await service.endpoint({ ...state.options("owner", true), staleLockMs: 1 })
      await assert.rejects(access(state.lockDirectory))
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("ages out ownerless, malformed, and legacy lifecycle locks but preserves fresh locks", async () => {
    for (const [name, owner] of [
      ["ownerless", undefined],
      ["malformed", "{"],
      ["legacy", JSON.stringify({ version: 1, identity: "legacy", pid: 1234, createdAt: 1 })],
    ] as const) {
      const state = await serviceState(`codenomad-service-${name}-lock-`)
      await mkdir(state.lockDirectory)
      if (owner) {
        const ownerFile = path.join(state.lockDirectory, "owner.json")
        await writeFile(ownerFile, owner)
        await utimes(ownerFile, 1, 1)
      }
      await utimes(state.lockDirectory, 1, 1)
      const service = createOwnedService(state, async () => true)
      try {
        await service.endpoint({ ...state.options("owner", true), staleLockMs: 10 })
        await assert.rejects(access(state.lockDirectory))
      } finally {
        await rm(state.root, { recursive: true, force: true })
      }
    }

    const fresh = await serviceState("codenomad-service-fresh-lock-")
    await mkdir(fresh.lockDirectory)
    const service = createOwnedService(fresh, async () => true)
    try {
      await assert.rejects(service.endpoint({ ...fresh.options("owner", true), timeoutMs: 10, staleLockMs: 60_000 }), /lifecycle lock/)
      await access(fresh.lockDirectory)
    } finally {
      await rm(fresh.root, { recursive: true, force: true })
    }
  })

  it("prunes an identity-checked lease after PID reuse", async () => {
    const state = await serviceState("codenomad-service-stale-lease-")
    const stalePid = 7654321
    const staleLease = path.join(state.leases, "stale.json")
    await writeFile(staleLease, JSON.stringify({
      version: 1,
      identity: "stale-peer",
      pid: stalePid,
      processIdentity: processIdentity(stalePid, "previous-process"),
      createdAt: 1,
      updatedAt: 1,
      state: "active",
    }))
    let stops = 0
    const service = createOwnedService(state, async () => { stops += 1; return true }, true, () => true)
    try {
      await service.endpoint(state.options("owner", true))
      await service.shutdown()
      assert.equal(stops, 1)
      await assert.rejects(access(staleLease))
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("quarantines stale registration after deterministic PID reuse without signaling it", async () => {
    const state = await serviceState("codenomad-service-stale-registration-")
    const reusedPid = state.info.pid
    await writeFile(state.lease("dead-owner"), JSON.stringify({
      version: 1,
      identity: "dead-owner",
      pid: 7654321,
      processIdentity: processIdentity(7654321, "dead-codenomad"),
      createdAt: 1,
      updatedAt: 1,
      state: "active",
      service: {
        info: state.info,
        endpoint: { url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } },
        registrationFile: state.file,
        nativePid: true,
        processIdentity: processIdentity(reusedPid, "old-service-process"),
      },
    }))
    const service = new OpenCodeSharedService({
      discover: async () => undefined,
      headers: () => undefined,
      isProcessAlive: () => true,
      getProcessIdentity: async (pid, _timeoutMs, namespace = { kind: "host" }) => processIdentity(
        pid,
        pid === reusedPid ? "reused-service-process" : `identity-${pid}`,
        namespace,
      ),
      makeClient: () => ({} as OpenCodeClient),
    })
    try {
      await assert.rejects(service.endpoint({
        ...state.options("successor", false),
        command: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 50,
      }), /exited before registration|timed out/)
      await assert.rejects(access(state.file))
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("recovers a registration written after a predecessor launch intent", async () => {
    const state = await serviceState("codenomad-service-crash-window-")
    const deadPid = 7654321
    const launchCreatedAt = Date.now() - 1_000
    await writeFile(state.lease("dead-owner"), JSON.stringify({
      version: 1,
      identity: "dead-owner",
      pid: deadPid,
      processIdentity: processIdentity(deadPid, "dead-codenomad"),
      createdAt: launchCreatedAt,
      updatedAt: launchCreatedAt,
      state: "active",
      launch: {
        identity: "launch-before-crash",
        createdAt: launchCreatedAt,
        nativePid: true,
        contenderFile: state.contenders,
      },
    }))
    const service = new OpenCodeSharedService({
      discover: async () => ({ url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } }),
      headers: () => undefined,
      isProcessAlive: (pid) => pid !== deadPid,
      getProcessIdentity: async (pid, _timeoutMs, namespace = { kind: "host" }) => processIdentity(pid, undefined, namespace),
      makeClient: () => ({} as OpenCodeClient),
    })
    try {
      await service.endpoint(state.options("successor", false))
      const lease = JSON.parse(await readFile(state.lease("successor"), "utf8"))
      assert.deepEqual(lease.service.processIdentity, processIdentity(state.info.pid))
      assert.equal(lease.service.info.pid, state.info.pid)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("prunes old invalid lease artifacts while preserving fresh writes", async () => {
    const state = await serviceState("codenomad-service-invalid-leases-")
    const oldLease = state.lease("invalid")
    const legacyLease = state.lease("legacy")
    const oldTemporary = `${state.lease("peer")}.peer-id.tmp`
    const freshLease = state.lease("fresh")
    await writeFile(oldLease, "{")
    await writeFile(legacyLease, JSON.stringify({
      version: 1,
      identity: "legacy",
      pid: 1234,
      createdAt: 1,
      updatedAt: 1,
      state: "active",
    }))
    await writeFile(oldTemporary, "partial")
    await writeFile(freshLease, "{")
    await Promise.all([utimes(oldLease, 1, 1), utimes(legacyLease, 1, 1), utimes(oldTemporary, 1, 1)])
    const service = createOwnedService(state, async () => true)
    try {
      await service.endpoint({ ...state.options("owner", true), staleLockMs: 60_000 })
      await assert.rejects(service.shutdown({ timeoutMs: 20 }), /invalid identity metadata/)
      await Promise.all([
        assert.rejects(access(oldLease)),
        assert.rejects(access(legacyLease)),
        assert.rejects(access(oldTemporary)),
      ])
      await access(freshLease)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("inherits proven ownership from a dead owner lease", async () => {
    const state = await serviceState("codenomad-service-dead-owner-")
    const deadPid = 7654321
    await writeFile(state.lease("dead-owner"), JSON.stringify({
      version: 1,
      identity: "dead-owner",
      pid: deadPid,
      processIdentity: processIdentity(deadPid),
      createdAt: 1,
      updatedAt: 1,
      state: "active",
      service: {
        info: state.info,
        endpoint: { url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } },
        registrationFile: state.file,
        nativePid: true,
      },
    }))
    let stops = 0
    const peer = createOwnedService(state, async () => { stops += 1; return true }, false, (pid) => pid !== deadPid)
    try {
      await peer.endpoint(state.options("peer", false))
      await peer.shutdown()
      assert.equal(stops, 1)
      await assert.rejects(access(state.lease("dead-owner")))
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("replaces stale in-memory ownership with a newer transferred service proof", async () => {
    const state = await serviceState("codenomad-service-replacement-owner-")
    const requested: string[] = []
    const staleOwner = createOwnedService(state, async (info) => { requested.push(info.id!); return true })
    const replacementOwner = createOwnedService(state, async () => { throw new Error("peer must not stop while an owner remains") })
    try {
      await staleOwner.endpoint(state.options("stale-owner", true))
      Object.assign(state.info, { id: "instance-2", pid: 5678, url: "http://127.0.0.1:5678", password: "replacement-secret" })
      await writeFile(state.file, JSON.stringify(state.info))
      await writeFile(state.contenders, `${state.info.pid}\n`)
      await replacementOwner.endpoint(state.options("replacement-owner", true))

      await replacementOwner.shutdown()
      assert.deepEqual(requested, [])
      await staleOwner.shutdown()
      assert.deepEqual(requested, ["instance-2"])
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("stops the proven endpoint without following a registration swap", async () => {
    const state = await serviceState("codenomad-service-swap-")
    const replacement = { ...state.info, id: "replacement", pid: 9999, url: "http://127.0.0.1:9999" }
    let requestedId: string | undefined
    const service = createOwnedService(state, async (info: Info, endpoint: Endpoint) => {
      await writeFile(state.file, JSON.stringify(replacement))
      requestedId = info.id
      assert.equal(endpoint.url, state.info.url)
      return true
    })
    try {
      await service.endpoint(state.options("owner", true))
      await service.shutdown()
      assert.equal(requestedId, state.info.id)
      assert.deepEqual(JSON.parse(await readFile(state.file, "utf8")), replacement)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("never owns a symlinked registration", { skip: process.platform === "win32" }, async () => {
    const state = await serviceState("codenomad-service-link-")
    const target = path.join(state.root, "target.json")
    await writeFile(target, JSON.stringify(state.info))
    await rm(state.file)
    await symlink(target, state.file)
    let stops = 0
    const service = createOwnedService(state, async () => { stops += 1; return true })
    try {
      await service.endpoint(state.options("owner", true))
      await service.shutdown()
      assert.equal(stops, 0)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("rejects a wrapper launch without a proven service PID before connecting", async () => {
    const state = await serviceState("codenomad-service-wrapper-")
    let launches = 0
    let discoveries = 0
    let stops = 0
    const service = new OpenCodeSharedService({
      discover: async () => { discoveries += 1; return undefined },
      ensure: async () => { launches += 1; return { url: state.info.url } },
      headers: () => undefined,
      requestStop: async () => { stops += 1; return true },
      makeClient: () => ({} as OpenCodeClient),
    })
    try {
      await assert.rejects(service.endpoint({
        ...state.options("wrapper", true),
        contenderFile: undefined,
        nativePid: false,
      }), /cannot prove the service PID/)
      await service.shutdown()
      assert.equal(launches, 0)
      assert.equal(discoveries, 0)
      assert.equal(stops, 0)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("bounds a stalled service stop", async () => {
    const state = await serviceState("codenomad-service-stop-timeout-")
    let stops = 0
    const service = createOwnedService(
      state,
      async () => { stops += 1; return new Promise<boolean>(() => undefined) },
      true,
      undefined,
      async () => false,
    )
    try {
      await service.endpoint(state.options("owner", true))
      await assert.rejects(service.shutdown({ timeoutMs: 10 }), /stop timed out/)
      const lease = JSON.parse(await readFile(state.lease("owner"), "utf8"))
      assert.equal(lease.state, "stopping")
      await assert.rejects(service.shutdown({ timeoutMs: 10 }), /uncertain outcome/)
      assert.equal(stops, 1)
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("retains ownership until an accepted stop actually completes", async () => {
    const state = await serviceState("codenomad-service-stop-completion-")
    let finishStop!: () => void
    let markAccepted!: () => void
    const accepted = new Promise<void>((resolve) => { markAccepted = resolve })
    const completion = new Promise<boolean>((resolve) => { finishStop = () => resolve(true) })
    const service = createOwnedService(state, async () => { markAccepted(); return true }, true, undefined, async () => completion)
    try {
      await service.endpoint(state.options("owner", true))
      const shutdown = service.shutdown({ timeoutMs: 100 })
      await accepted
      await access(state.lease("owner"))
      assert.equal(JSON.parse(await readFile(state.lease("owner"), "utf8")).state, "stopping")
      finishStop()
      await shutdown
      await assert.rejects(access(state.lease("owner")))
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("checks WSL stop completion in the distro despite a coincidental live Windows PID", async () => {
    const state = await serviceState("codenomad-service-wsl-stop-")
    let healthChecks = 0
    let wslPidExists = true
    const server = (await import("node:http")).createServer((_request, response) => {
      healthChecks += 1
      if (healthChecks <= 2) {
        response.destroy()
        return
      }
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ healthy: true, version: "test", pid: state.info.pid }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    state.info.url = `http://127.0.0.1:${address.port}`
    await writeFile(state.file, JSON.stringify(state.info))
    const wslNamespace = { kind: "wsl", distro: "Ubuntu" } as const
    const service = createOwnedService(
      state,
      async () => true,
      true,
      () => true,
      undefined,
      true,
      async (pid, _timeoutMs, namespace = { kind: "host" }) => processIdentity(pid, undefined, namespace),
      async (pid, _timeoutMs, namespace) => wslPidExists
        ? { status: "found", identity: processIdentity(pid, undefined, namespace) }
        : { status: "missing" },
    )
    try {
      await service.endpoint({ ...state.options("owner", true), nativePid: false, wslDistro: "Ubuntu" })
      assert.equal(JSON.parse(await readFile(state.lease("owner"), "utf8")).service.nativePid, false)
      assert.deepEqual(JSON.parse(await readFile(state.lease("owner"), "utf8")).service.processIdentity.namespace, wslNamespace)
      await assert.rejects(service.shutdown({ timeoutMs: 500 }), /did not exit|completion timed out/)
      assert.ok(healthChecks > 2)
      assert.equal(JSON.parse(await readFile(state.lease("owner"), "utf8")).state, "stopping")
      wslPidExists = false
      await service.shutdown({ timeoutMs: 100 })
      await assert.rejects(access(state.lease("owner")))
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("reports a failed stop and keeps an active retryable lease", async () => {
    const state = await serviceState("codenomad-service-stop-failure-")
    let stops = 0
    const service = createOwnedService(state, async () => { stops += 1; return stops > 1 })
    try {
      await service.endpoint(state.options("owner", true))
      await assert.rejects(service.shutdown(), /failed the stop request/)
      const lease = JSON.parse(await readFile(state.lease("owner"), "utf8"))
      assert.equal(lease.state, "active")
      await service.shutdown()
      assert.equal(stops, 2)
      await assert.rejects(access(state.lease("owner")))
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("bounds a stalled ensure", async () => {
    const service = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => new Promise<never>(() => undefined),
      headers: () => undefined,
      makeClient: () => ({} as OpenCodeClient),
    })
    await assert.rejects(service.endpoint({ timeoutMs: 10 }), /timed out after 10ms/)
  })

  it("reconciles a late uncancellable ensure during shutdown", async () => {
    const state = await serviceState("codenomad-service-late-ensure-")
    let finishEnsure!: () => void
    let finishStop!: () => void
    let markStopStarted!: () => void
    const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve })
    const stopCompletion = new Promise<boolean>((resolve) => { finishStop = () => resolve(true) })
    let stops = 0
    const service = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: (options) => new Promise<Endpoint>((resolve) => {
        options?.onStart?.("missing")
        finishEnsure = () => resolve({
          url: state.info.url,
          auth: { type: "basic", username: "opencode", password: state.info.password },
        })
      }),
      headers: () => undefined,
      requestStop: async () => { stops += 1; markStopStarted(); return true },
      waitForStop: async () => stopCompletion,
      getProcessIdentity: async (pid, _timeoutMs, namespace = { kind: "host" }) => processIdentity(pid, undefined, namespace),
      makeClient: () => ({} as OpenCodeClient),
    })
    try {
      await assert.rejects(service.endpoint({ ...state.options("owner", true), timeoutMs: 10 }), /ensure timed out/)
      await access(state.lease("owner"))
      await assert.rejects(service.shutdown({ timeoutMs: 10 }), /launch reconciliation timed out/)
      finishEnsure()
      await stopStarted
      const reconciliation = service.shutdown({ timeoutMs: 100 })
      finishStop()
      await reconciliation
      assert.equal(stops, 1)
      await assert.rejects(access(state.lease("owner")))
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })
})

async function serviceState(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  const file = path.join(root, "service.json")
  const contenders = path.join(root, "contenders.txt")
  const leases = path.join(root, "leases")
  const lockDirectory = path.join(root, "stop.lock")
  const info = { id: "instance-1", url: "http://127.0.0.1:4321", pid: 1234, password: "secret" }
  await mkdir(leases)
  await writeFile(file, JSON.stringify(info))
  await writeFile(contenders, `${info.pid}\n`)
  return {
    root, file, contenders, leases, lockDirectory, info,
    lease(name: string) { return path.join(leases, `${name}.json`) },
    options(name: string, started: boolean): OpenCodeEnsureOptions {
      return {
        file,
        contenderFile: contenders,
        leaseFile: path.join(leases, `${name}.json`),
        lockDirectory,
        onStart: started ? () => undefined : undefined,
      }
    },
  }
}

function createOwnedService(
  state: Awaited<ReturnType<typeof serviceState>>,
  requestStop: (info: Info, endpoint: Endpoint, timeoutMs: number) => Promise<boolean>,
  announceStart = true,
  isProcessAlive?: (pid: number) => boolean,
  waitForStop?: (info: Info, endpoint: Endpoint, timeoutMs: number) => Promise<boolean>,
  useDefaultWaitForStop = false,
  getProcessIdentity: (
    pid: number,
    timeoutMs: number,
    namespace?: ProcessNamespace,
  ) => Promise<ProcessIdentity | undefined> = async (pid, _timeoutMs, namespace = { kind: "host" }) => processIdentity(pid, undefined, namespace),
  probeProcessIdentity?: (
    pid: number,
    timeoutMs: number,
    namespace?: ProcessNamespace,
  ) => Promise<ProcessIdentityProbe>,
) {
  return new OpenCodeSharedService({
    discover: async () => ({ url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } }),
    ensure: async (options) => {
      if (announceStart) options?.onStart?.("missing")
      return { url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } }
    },
    headers: () => undefined,
    requestStop,
    waitForStop: useDefaultWaitForStop ? undefined : waitForStop ?? (async () => true),
    isProcessAlive,
    getProcessIdentity,
    probeProcessIdentity,
    makeClient: () => ({} as OpenCodeClient),
  })
}

function processIdentity(
  pid: number,
  start = `identity-${pid}`,
  namespace: ProcessNamespace = { kind: "host" },
): ProcessIdentity {
  return { namespace, pid, start }
}
