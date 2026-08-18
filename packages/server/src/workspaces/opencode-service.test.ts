import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { createHash } from "node:crypto"
import type { OpenCodeClient } from "@opencode-ai/client"
import type { Endpoint, Info } from "@opencode-ai/client/service"

import { OpenCodeSharedService, type OpenCodeEnsureOptions } from "./opencode-service"
import type { ProcessIdentity, ProcessIdentityProbe, ProcessNamespace } from "./process-identity"

describe("OpenCodeSharedService", () => {
  it("rejects a changed launch signature instead of reusing the connected daemon", async () => {
    const endpoint = { url: "http://127.0.0.1:4321", auth: undefined }
    const service = new OpenCodeSharedService({
      discover: async () => endpoint,
      ensure: async () => endpoint,
      headers: () => undefined,
      makeClient: () => ({} as OpenCodeClient),
    })
    await service.endpoint({ version: "0.0.0-next-17444", command: ["first"], environment: { OPENCODE_DB: "/one" } })
    await assert.rejects(
      service.endpoint({ version: "0.0.0-next-17444", command: ["first"], environment: { OPENCODE_DB: "/two" } }),
      /launch configuration/,
    )
  })

  it("validates a caller workspace selector against the canonical location", async () => {
    const service = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => ({ url: "http://127.0.0.1:4321" }),
      headers: () => undefined,
      makeClient: () => ({ location: { get: async () => ({
        directory: "/repo", workspaceID: "canonical", project: { id: "p", directory: "/repo", canonical: "/repo" },
      }) } }) as unknown as OpenCodeClient,
    })
    await assert.rejects(service.validateLocation({ directory: "/repo", workspaceID: "foreign" }), /does not match/)
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
    const options = {
      ...state.options("successor", false),
      command: [process.execPath, "-e", "process.exit(0)"],
      timeoutMs: 50,
    }
    const launchSignature = signature(options)
    await writeFile(state.lease("dead-owner"), JSON.stringify({
      version: 1,
      identity: "dead-owner",
      pid: 7654321,
      processIdentity: processIdentity(7654321, "dead-codenomad"),
      createdAt: 1,
      updatedAt: 1,
      state: "active",
      launchSignature,
      service: {
        info: state.info,
        endpoint: { url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } },
        registrationFile: state.file,
        nativePid: true,
        processIdentity: processIdentity(reusedPid, "old-service-process"),
        launchSignature,
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
      await assert.rejects(service.endpoint(options), /exited before registration|timed out/)
      await assert.rejects(access(state.file))
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
    const options = state.options("peer", false)
    const launchSignature = signature(options)
    await writeFile(state.lease("dead-owner"), JSON.stringify({
      version: 1,
      identity: "dead-owner",
      pid: deadPid,
      processIdentity: processIdentity(deadPid),
      createdAt: 1,
      updatedAt: 1,
      state: "active",
      launchSignature,
      service: {
        info: state.info,
        endpoint: { url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } },
        registrationFile: state.file,
        nativePid: true,
        launchSignature,
      },
    }))
    let stops = 0
    const peer = createOwnedService(state, async () => { stops += 1; return true }, false, (pid) => pid !== deadPid)
    try {
      await peer.endpoint(options)
      await peer.shutdown()
      assert.equal(stops, 1)
      await assert.rejects(access(state.lease("dead-owner")))
    } finally {
      await rm(state.root, { recursive: true, force: true })
    }
  })

  it("rejects stale ownership proof from a daemon launched with a different OPENCODE_DB", async () => {
    const state = await serviceState("codenomad-service-stale-signature-")
    const owner = createOwnedService(state, async () => true)
    const successor = createOwnedService(state, async () => true, false, () => true)
    const deadPid = 7654321
    try {
      await owner.endpoint({ ...state.options("dead-owner", true), environment: { OPENCODE_DB: "/db/one" } })
      const staleLease = JSON.parse(await readFile(state.lease("dead-owner"), "utf8"))
      staleLease.pid = deadPid
      staleLease.processIdentity = processIdentity(deadPid, "dead-codenomad")
      await writeFile(state.lease("dead-owner"), JSON.stringify(staleLease))

      await assert.rejects(
        successor.endpoint({ ...state.options("successor", false), environment: { OPENCODE_DB: "/db/two" } }),
        /does not match the discovered daemon/,
      )
      await assert.rejects(access(state.lease("successor")))
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

  it("delegates proven host shutdown to Service.stop with the registration file", async () => {
    const state = await serviceState("codenomad-service-sdk-stop-")
    let stopFile: string | undefined
    const service = new OpenCodeSharedService({
      discover: async () => ({ url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } }),
      ensure: async (options) => {
        options?.onStart?.("missing")
        return { url: state.info.url, auth: { type: "basic", username: "opencode", password: state.info.password } }
      },
      stop: async (options) => { stopFile = options?.file },
      headers: () => undefined,
      waitForStop: async () => true,
      getProcessIdentity: async (pid, _timeoutMs, namespace = { kind: "host" }) => processIdentity(pid, undefined, namespace),
      makeClient: () => ({} as OpenCodeClient),
    })
    try {
      await service.endpoint(state.options("owner", true))
      await service.shutdown()
      assert.equal(stopFile, state.file)
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

  it("checks WSL stop completion in the distro despite a coincidental live Windows PID", async () => {
    const state = await serviceState("codenomad-service-wsl-stop-")
    let healthChecks = 0
    let sdkStops = 0
    let wslPidExists = true
    const server = (await import("node:http")).createServer((request, response) => {
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
    const endpoint = { url: state.info.url, auth: { type: "basic" as const, username: "opencode", password: state.info.password } }
    const service = new OpenCodeSharedService({
      discover: async () => endpoint,
      ensure: async (options) => { options?.onStart?.("missing"); return endpoint },
      stop: async () => { sdkStops += 1 },
      headers: () => undefined,
      isProcessAlive: () => true,
      getProcessIdentity: async (pid, _timeoutMs, namespace = { kind: "host" }) => processIdentity(pid, undefined, namespace),
      probeProcessIdentity: async (pid, _timeoutMs, namespace) => wslPidExists
        ? { status: "found", identity: processIdentity(pid, undefined, namespace) }
        : { status: "missing" },
      makeClient: () => ({} as OpenCodeClient),
    })
    try {
      await service.endpoint({ ...state.options("owner", true), nativePid: false, wslDistro: "Ubuntu" })
      assert.equal(JSON.parse(await readFile(state.lease("owner"), "utf8")).service.nativePid, false)
      assert.deepEqual(JSON.parse(await readFile(state.lease("owner"), "utf8")).service.processIdentity.namespace, wslNamespace)
      await assert.rejects(service.shutdown({ timeoutMs: 500 }), /did not exit|completion timed out/)
      assert.equal(sdkStops, 1)
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

  it("bounds stalled ensure and stop operations", async () => {
    const stalledEnsure = new OpenCodeSharedService({
      discover: async () => undefined,
      ensure: async () => new Promise<never>(() => undefined),
      headers: () => undefined,
      makeClient: () => ({} as OpenCodeClient),
    })
    await assert.rejects(stalledEnsure.endpoint({ timeoutMs: 10 }), /timed out after 10ms/)

    const state = await serviceState("codenomad-service-stop-timeout-")
    let stops = 0
    const stalledStop = createOwnedService(
      state,
      async () => { stops += 1; return new Promise<boolean>(() => undefined) },
      true,
      undefined,
      async () => false,
    )
    try {
      await stalledStop.endpoint(state.options("owner", true))
      await assert.rejects(stalledStop.shutdown({ timeoutMs: 10 }), /stop timed out/)
      assert.equal(JSON.parse(await readFile(state.lease("owner"), "utf8")).state, "stopping")
      await assert.rejects(stalledStop.shutdown({ timeoutMs: 10 }), /uncertain outcome/)
      assert.equal(stops, 1)
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

function signature(options: OpenCodeEnsureOptions): string {
  const environment = Object.entries(options.environment ?? {}).sort(([left], [right]) => left.localeCompare(right))
  return createHash("sha256").update(JSON.stringify({
    command: options.command ?? [],
    environment,
    version: options.version ?? null,
    wslDistro: options.wslDistro ?? null,
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
  })).digest("hex")
}
