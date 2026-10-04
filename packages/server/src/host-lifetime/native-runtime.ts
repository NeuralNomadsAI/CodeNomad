import { createHash, randomBytes } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { BackendLaunch } from "./backend"
import { HostError, MAX_BYTES, TIMEOUT_MS, validateScope, type Scope } from "./protocol"
import { NativeRuntimeBinding, type NativeBirth, type NativeManagerFacts } from "./native-runtime-binding"
import { RuntimeOpcode, RuntimeTransport, memberRequest } from "./native-runtime-transport"
import type { NativeServiceStartRequest } from "../workspaces/native-service-launcher"
import { NativeDeadline } from "./native-deadline"

export interface NativeManagerLaunch { root: string; scope: Scope; generation: string; backend: BackendLaunch }
const minted = new WeakSet<NativeRuntimeCapability>()
const MINT = Symbol("native-runtime-factory-mint")
const FILETIME_OFFSET = 504911232000000000n
function birth(value: NativeBirth): void {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 0xffffffff
    || typeof value.filetime !== "string" || !/^[1-9]\d{0,19}$/.test(value.filetime) || BigInt(value.filetime) > 0xffffffffffffffffn)
    throw new HostError("invalid-native-birth")
}
export function runtimeStartIdentity(value: NativeBirth): string { birth(value); return `win32:${BigInt(value.filetime) + FILETIME_OFFSET}` }
function sameBirth(a: NativeBirth, b: NativeBirth): boolean { return a.pid === b.pid && a.filetime === b.filetime }
function validateFacts(facts: NativeManagerFacts, launch: NativeManagerLaunch, nonce: Buffer): void {
  validateScope(launch.scope)
  birth(facts.manager); birth(facts.supervisor); birth(facts.servicePeer)
  if (facts.nonce !== nonce.toString("hex") || facts.generation !== launch.generation || facts.scope.key !== launch.scope.key
    || facts.scope.channel !== launch.scope.channel || facts.scope.configIdentity !== launch.scope.configIdentity
    || facts.manager.pid !== process.pid || !/^[a-f0-9]{64}$/.test(facts.runtimeId) || facts.alive !== true
    || facts.assignedSuspended !== true || facts.supervisorOutsideAllJobs !== true || facts.ownerBootstrapVerified !== true
    || facts.soleJobOwnerPid !== facts.supervisor.pid
    || facts.jobHandleInherited !== false || facts.limitFlags !== 0x2000 || facts.servicePeer.outsideAllJobs !== true
    || facts.servicePeer.pid === facts.manager.pid || facts.servicePeer.policyScope !== launch.scope.key
    || facts.servicePeer.launcher !== "native-service-launcher-v1") throw new HostError("native-runtime-unqualified")
}
function launchRecord(bytes: Buffer): NativeManagerLaunch {
  if (bytes.length > MAX_BYTES) throw new HostError("native-launch-too-large")
  const launch = JSON.parse(bytes.toString()) as NativeManagerLaunch
  validateScope(launch.scope)
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(launch.generation) || !path.isAbsolute(launch.root)
    || !launch.backend || !path.isAbsolute(launch.backend.file) || !path.isAbsolute(launch.backend.cwd)
    || !Array.isArray(launch.backend.args) || launch.backend.args.some(arg => typeof arg !== "string")
    || (launch.backend.env && Object.values(launch.backend.env).some(value => typeof value !== "string")))
    throw new HostError("invalid-native-launch")
  const wrapper = fileURLToPath(new URL(`./backend-entry${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url))
  if (!launch.backend.args.includes(wrapper)) throw new HostError("native-backend-wrapper-required")
  return launch
}
function serviceRequest(params: unknown, deadline: number): Buffer {
  const value = params as NativeServiceStartRequest
  if (!value || typeof value.file !== "string" || !value.file || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string")
    || Object.keys(value).some(key => !["file", "args", "env", "cwd", "windowsVerbatimArguments"].includes(key))
    || typeof value.cwd !== "string" || !value.env || typeof value.env !== "object" || Array.isArray(value.env)
    || Object.values(value.env).some(item => typeof item !== "string") || typeof value.windowsVerbatimArguments !== "boolean"
    || !Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 30_000)
    throw new HostError("invalid-native-service-request")
  // Preserve selected file, args, complete env, cwd and verbatim option exactly.
  const bytes = Buffer.from(JSON.stringify({ request: value, deadline }))
  if (bytes.length > MAX_BYTES - 8192) throw new HostError("native-service-request-too-large")
  return bytes
}
function immutableLaunch(launch: NativeManagerLaunch): NativeManagerLaunch {
  Object.freeze(launch.scope)
  Object.freeze(launch.backend.args)
  if (launch.backend.env) Object.freeze(launch.backend.env)
  Object.freeze(launch.backend)
  return Object.freeze(launch)
}
export class NativeRuntimeCapability {
  private stopped = false
  private ending?: Promise<void>
  private released = false
  private readonly transport: RuntimeTransport
  private constructor(private readonly binding: NativeRuntimeBinding, private readonly session: object,
    readonly launch: NativeManagerLaunch, private readonly initial: NativeManagerFacts,
    channel: ConstructorParameters<typeof RuntimeTransport>[0], key: Buffer, private readonly launchDigest: string, mint: symbol) {
    if (mint !== MINT) throw new HostError("native-runtime-capability-required")
    this.transport = new RuntimeTransport(channel, key, launch.scope.key, launch.generation)
    this.transport.onLoss(() => { this.stopped = true; this.releaseSession() })
    minted.add(this)
  }
  static async open(binding: NativeRuntimeBinding): Promise<NativeRuntimeCapability> { return this.connect(binding, false) }
  static assert(capability: NativeRuntimeCapability, fixture = false): void {
    if (!minted.has(capability)) throw new HostError("native-runtime-capability-required")
    NativeRuntimeBinding.assert(capability.binding, fixture)
  }
  /** @internal SDK stubs only; production Manager rejects this capability. */
  static async forPrivateFixture(binding: NativeRuntimeBinding): Promise<NativeRuntimeCapability> { return this.connect(binding, true) }
  private static async connect(binding: NativeRuntimeBinding, fixture: boolean): Promise<NativeRuntimeCapability> {
    NativeRuntimeBinding.assert(binding, fixture)
    let opened: Awaited<ReturnType<NativeRuntimeBinding["sdk"]["openManager"]>> | undefined
    let expired = false
    const dispose = (value: NonNullable<typeof opened>) => {
      value.channel.destroy(); value.key.fill(0)
      try { binding.sdk.release(value.nativeSession) } catch { /* Private native details never escape. */ }
    }
    const budget = new NativeDeadline(TIMEOUT_MS, undefined, () => { expired = true })
    try {
      const nonce = randomBytes(32)
      const connection = await budget.observe<NonNullable<typeof opened>>(() => binding.sdk.openManager(nonce).then(value => {
        opened = value
        try {
          budget.check()
          if (expired) throw new HostError("native-runtime-timeout")
          return value
        } catch (error) { opened = undefined; dispose(value); throw error }
      }))
      opened = connection
      const launch = immutableLaunch(launchRecord(connection.launch))
      const digest = createHash("sha256").update(connection.launch).digest("hex")
      const facts = await budget.observe(() => binding.sdk.verifyManager(connection.nativeSession, nonce, digest, connection.attestation))
      // Launch digest, CNG challenge, native source endpoint and actual process/
      // Job facts are verified natively before any JSON becomes launch authority.
      validateFacts(facts, launch, nonce)
      Object.freeze(facts.manager); Object.freeze(facts.supervisor); Object.freeze(facts.servicePeer); Object.freeze(facts.scope); Object.freeze(facts)
      budget.check()
      return new NativeRuntimeCapability(binding, connection.nativeSession, launch, facts, connection.channel, connection.key, digest, MINT)
    } catch {
      expired = true
      if (opened) dispose(opened)
      throw new HostError("native-runtime-qualification-failed")
    }
  }
  assertFor(scope: Scope, generation: string, startIdentity: string, fixture = false): void {
    if (!minted.has(this) || (!fixture && !this.binding.production) || this.launch.scope.key !== scope.key
      || this.launch.scope.channel !== scope.channel || this.launch.scope.configIdentity !== scope.configIdentity
      || this.launch.generation !== generation || runtimeStartIdentity(this.initial.manager) !== startIdentity)
      throw new HostError("native-runtime-capability-required")
  }
  assertLaunch(directory: string, backend: BackendLaunch): void {
    if (path.resolve(directory) !== path.join(this.launch.root, this.launch.scope.key)
      || JSON.stringify(backend) !== JSON.stringify(this.launch.backend)) throw new HostError("native-runtime-launch-mismatch")
  }
  onLoss(listener: () => void): () => void { return this.transport.onLoss(listener) }
  async beforeSpawn(deadline = Date.now() + TIMEOUT_MS): Promise<void> {
    try {
      const budget = this.budget(deadline)
      if (this.stopped || !this.transport.available) throw new Error()
      // Fixed member query of THIS M, never caller-supplied PID authority. S
      // returns fresh exact-Job/owner/outside-service facts; the compiled verifier
      // authenticates that raw native receipt, not parsed JSON booleans.
      const request = memberRequest(process.pid)
      const receipt = await this.transport.request(RuntimeOpcode.member, request.bytes, budget.expires)
      const facts = await budget.observe(() => this.binding.sdk.verifyManager(this.session, request.nonce, this.launchDigest, receipt))
      validateFacts(facts, this.launch, request.nonce)
      if (!sameBirth(facts.manager, this.initial.manager) || !sameBirth(facts.supervisor, this.initial.supervisor)
        || !sameBirth(facts.servicePeer, this.initial.servicePeer) || facts.runtimeId !== this.initial.runtimeId) throw new Error()
      budget.check()
      if (this.stopped || !this.transport.available) throw new Error()
    } catch {
      this.stopped = true; this.transport.close()
      throw new HostError("native-runtime-pre-spawn-denied")
    }
  }
  async admitBackend(child: ChildProcess, expectedIdentity: string, deadline?: number): Promise<void> {
    try {
      const budget = this.budget(deadline)
      const request = memberRequest(child.pid!)
      const receipt = await this.transport.request(RuntimeOpcode.member, request.bytes, budget.expires)
      const facts = await budget.observe(() => this.binding.sdk.verifyMember(this.session, child.pid!, request.nonce, receipt))
      birth(facts.member)
      if (this.stopped || child.exitCode !== null || child.signalCode !== null || facts.nonce !== request.nonce.toString("hex")
        || facts.runtimeId !== this.initial.runtimeId || facts.member.pid !== child.pid || facts.alive !== true || facts.inherited !== true
        || runtimeStartIdentity(facts.member) !== expectedIdentity) throw new Error()
      budget.check()
    } catch { throw new HostError("native-runtime-backend-denied") }
  }
  async startService(params: unknown, deadline: number): Promise<{ stdout: string; stderr: string }> {
    try {
      const budget = this.budget(deadline, 30_000)
      await this.beforeSpawn(deadline) // Fresh service-peer/runtime facts, not a cached env/settings policy.
      const bytes = serviceRequest(params, deadline)
      const digest = createHash("sha256").update(bytes).digest("hex")
      const permit = await budget.observe(() => this.binding.sdk.authorizeService(this.session, bytes, deadline))
      if (!Buffer.isBuffer(permit) || permit.length < 32 || permit.length > 4096) throw new Error()
      const length = Buffer.alloc(4); length.writeUInt32LE(permit.length)
      const response = await this.transport.request(RuntimeOpcode.serviceStart, Buffer.concat([length, permit, bytes]), deadline)
      // Response: u32 native attestation length, raw receipt, bounded JSON output.
      if (response.length < 4 || response.readUInt32LE() > 4096 || response.readUInt32LE() > response.length - 4) throw new Error()
      const end = 4 + response.readUInt32LE()
      const facts = await budget.observe(() => this.binding.sdk.verifyService(this.session, digest, response.subarray(4, end)))
      birth(facts.peer); birth(facts.starter)
      if (facts.requestDigest !== digest || facts.runtimeId !== this.initial.runtimeId || !sameBirth(facts.peer, this.initial.servicePeer)
        || facts.starter.pid === this.initial.manager.pid || facts.starter.pid === this.initial.supervisor.pid || facts.starter.pid === this.initial.servicePeer.pid
        || facts.outsideAllJobsBeforeResume !== true || facts.originalExecutionPreserved !== true || facts.policyScope !== this.launch.scope.key) throw new Error()
      const result = JSON.parse(response.subarray(end).toString()) as { stdout: string; stderr: string }
      if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || Buffer.byteLength(result.stdout) > 64 * 1024
        || Buffer.byteLength(result.stderr) > 64 * 1024 || Date.now() >= deadline) throw new Error()
      budget.check()
      if (this.stopped || !this.transport.available) throw new Error()
      return result
    } catch { throw new HostError("native-service-start-failed") }
  }
  async fatal(reason: "backend-exit" | "startup-failed" | "owner-lost" | "election-lost"): Promise<void> {
    if (!["backend-exit", "startup-failed", "owner-lost", "election-lost"].includes(reason))
      throw new HostError("invalid-runtime-fatal")
    return this.end(RuntimeOpcode.fatal, Buffer.from(reason))
  }
  async stopDrained(): Promise<void> {
    return this.end(RuntimeOpcode.stopDrained, Buffer.alloc(0))
  }
  private end(opcode: typeof RuntimeOpcode.fatal | typeof RuntimeOpcode.stopDrained, payload: Buffer): Promise<void> {
    if (this.ending) return this.ending
    this.stopped = true
    return this.ending = (async () => {
      try {
        const response = await this.transport.request(opcode, payload, Date.now() + TIMEOUT_MS)
        if (response.length !== 0) throw new HostError("invalid-runtime-acknowledgement")
      }
      finally { this.transport.close(); this.releaseSession() }
    })()
  }
  private releaseSession(): void {
    if (this.released) return
    this.released = true
    try { this.binding.sdk.release(this.session) } catch { /* Never return native handle/error detail. */ }
  }
  private budget(deadline?: number, cap = TIMEOUT_MS): NativeDeadline {
    if (this.stopped || !this.transport.available) throw new HostError("native-runtime-unavailable")
    return new NativeDeadline(cap, deadline, () => {
      this.stopped = true; this.transport.close()
    })
  }
}
