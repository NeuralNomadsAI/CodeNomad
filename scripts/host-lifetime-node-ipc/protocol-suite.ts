// Shared real BackendProcess protocol exercise. Never constructs native ownership.
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { BackendProcess } from "../../packages/server/src/host-lifetime/backend"

type NativeBirth = { pid: number; creationFiletime: string }
type Admission = (pid: number) => Promise<NativeBirth>
export class BackendHarness {
  readonly children: BackendProcess[] = []
  readonly exits: Promise<void>[] = []
  readonly closed = new Set<BackendProcess>()
  private readonly admitted = new Map<BackendProcess, NativeBirth>()
  constructor(private readonly root: string, private readonly admission?: Admission) {}
  start(): BackendProcess {
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
    const backend: BackendProcess = new BackendProcess({ file: process.execPath,
      args: ["--import", new URL("./loader.mjs", import.meta.url).href,
        fileURLToPath(new URL("./backend-control.ts", import.meta.url)), this.root,
        this.admission ? "runtime" : "direct"], cwd: process.cwd(), env }, async (call): Promise<unknown> => {
      if (call.method === "runtime.fixture.admission") {
        assert.ok(this.admission)
        assert.equal((call.params as { pid: number }).pid, backend.child.pid)
        const birth = await this.admission!(backend.child.pid!) // Native S checks membership.
        this.admitted.set(backend, birth)
        return birth
      }
      assert.equal(call.method, "browser.fixture.challenge")
      assert.ok(/^[a-f0-9]{64}$/.test((call.params as { nonce: string }).nonce))
      return call.params
    })
    this.children.push(backend)
    this.exits.push(new Promise(resolve => backend.child.once("exit", () => resolve())))
    backend.child.once("close", () => this.closed.add(backend))
    return backend
  }
  async ready(backend: BackendProcess) {
    const ready = await backend.ready // Unmodified authoritative native lookup.
    if (this.admission) {
      const birth = this.admitted.get(backend)
      assert.ok(birth)
      assert.equal(birth.pid, ready.pid)
      assert.equal(ready.startIdentity,
        `win32:${BigInt(birth.creationFiletime) + 504911232000000000n}`)
    }
    return ready
  }
  request(backend: BackendProcess, action: string, fields = {}) {
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("fixture-timeout")), 4000)
      const message = (input: unknown) => {
        const value = input as { fixture?: number; id?: string; result?: unknown }
        if (value?.fixture === 1 && value.id === id) finish(undefined, value.result)
      }
      const exit = () => finish(new Error("fixture-exit"))
      function finish(error?: Error, result?: unknown) {
        clearTimeout(timer); backend.child.off("message", message); backend.child.off("exit", exit)
        if (error) reject(error); else resolve(result)
      }
      backend.child.on("message", message); backend.child.once("exit", exit)
      backend.child.send({ fixture: 1, id, action, ...fields }, error => { if (error) finish(error) })
    })
  }
  exited(backend: BackendProcess) {
    return new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture-exit-timeout")), 4000)
      backend.child.once("exit", code => { clearTimeout(timer); resolve(code) })
    })
  }
  async cleanup() {
    for (const { child } of this.children) {
      if (child.connected) child.disconnect()
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()
    }
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([Promise.all(this.exits), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("owned-exit-timeout")), 4000)
      })])
    } finally { clearTimeout(timer) }
  }
}

export async function exerciseProtocol(harness: BackendHarness) {
  const backend = harness.start()
  await harness.ready(backend)
  const nonce = randomBytes(32).toString("hex")
  assert.deepEqual(await harness.request(backend, "channel", { nonce }),
    { nonce, send: true, connected: true, envRemoved: true, serializationRemoved: true })
  const observedIds = new Set<string>()
  const observe = (input: unknown) => {
    const value = input as { host?: number; id?: string; result?: unknown }
    if (value?.host === 1 && typeof value.id === "string") observedIds.add(value.id)
  }
  backend.child.on("message", observe)
  const first = randomUUID(), second = randomUUID()
  const [a, b] = await Promise.all([backend.request("proof", first), backend.request("proof", second)])
  assert.equal(typeof a, "string"); assert.equal(typeof b, "string")
  assert.match(a as string, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b)
  assert.equal(observedIds.size, 2)
  assert.equal(await harness.request(backend, "consume", { token: a }), true)
  assert.equal(await harness.request(backend, "consume", { token: a }), false)
  assert.equal(await harness.request(backend, "consume", { token: b }), true)
  const revoked = await backend.request("proof", first)
  assert.equal(await backend.request("revoke", first), true)
  assert.equal(await harness.request(backend, "consume", { token: revoked }), false)
  assert.deepEqual(await harness.request(backend, "native"), { correlated: true })
  backend.child.off("message", observe)
  await backend.stop(4000)
  const disconnected = harness.start(); await harness.ready(disconnected)
  const disconnectExit = harness.exited(disconnected)
  disconnected.child.disconnect()
  assert.equal(await disconnectExit, 1); assert.equal(disconnected.child.connected, false)
  const ended = harness.start(); await harness.ready(ended)
  const endExit = harness.exited(ended)
  ended.child.stdin!.end()
  assert.equal(await endExit, 1)
  await harness.cleanup()
  return { actualNodeIpc: true, correlatedChallenge: true, concurrentAuthManagerProofs: true,
    oneShotAndRevoke: true, nativeParentRoundTrip: true, stdinShutdownStdoutStatus: true,
    disconnectFatal: true, unexpectedStdinEndFatal: true, exactOwnedChildrenExited: true,
    aggregateCloseObserved: harness.children.map(child => harness.closed.has(child)) }
}
