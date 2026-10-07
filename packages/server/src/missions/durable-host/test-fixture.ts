// ISOLATED native-domain fixture: file policy and native capability are injected.
// This is not persistent-host/native RuntimeSession or DACL qualification proof.
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import pino from "pino"
import type { FastifyRequest } from "fastify"
import type { SessionInboxSynthetic, SessionSyntheticInput } from "@opencode/client"
import type { MissionTaskExecutionMode } from "../task-execution-mode"
import { AuthManager } from "../../auth/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { FamilyAuthorityStore, readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { MissionJournal, type MissionStorage } from "../journal"
import { NativeMissionAuthorityStore, type AuthorityReceipt } from "../authority-store"
import type { MissionJsonValue } from "../model"
import { setupDurableMissionsPlugin, type DurableMissionsContext, type DurableMissionsHost } from "../../opencode/missions/durable-plugin"
import { fixture as protectedFixture, structuralTestPolicy } from "../host-authority/test-fixture"
import { assembleCanonicalDurableMissionsHost, type CanonicalDurableHostDependencies, type QualifiedNativeMissionChannel } from "./factory"

class Storage implements MissionStorage {
  readonly data = new Map<string, MissionJsonValue>()
  writes = 0
  async get(key: string) { return structuredClone(this.data.get(key)) }
  async set(key: string, value: MissionJsonValue) { this.writes++; this.data.set(key, structuredClone(value)) }
  async remove(key: string) { this.data.delete(key) }
  async scan({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.data.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
    return { entries: keys.slice(0, limit).map(key => ({ key, value: structuredClone(this.data.get(key)!) })),
      ...(keys.length > limit ? { next: keys[limit - 1] } : {}) }
  }
}
export async function fixture() {
  const f = await protectedFixture()
  execFileSync("git", ["init", "--quiet", f.project], { windowsHide: true })
  const storage = new Storage()
  const nativeStore = new NativeMissionAuthorityStore(storage, "test-project", f.project)
  await nativeStore.initialize()
  const namespace = (await nativeStore.read()).namespace
  const familyRoot = path.join(f.root, "families"); await mkdir(familyRoot)
  const family = await readFamilyAuthorityIdentity(f.project)
  const familyStore = new FamilyAuthorityStore({ root: familyRoot, profileKey: f.descriptor.scope.key, executionHostKey: f.descriptor.executionHost,
    policy: structuralTestPolicy, lookup: async () => ({ state: "live", startIdentity: "isolated-fixture-process" }) })
  const claim = await familyStore.acquire(family)
  let nativeCurrent = true, claimCurrent = true, failInterrupt = false
  let prepareEnvironment: (() => Promise<void>) | undefined, environmentWrite: (() => Promise<void>) | undefined
  let afterSessionGet: (() => Promise<void>) | undefined, receiptRead: ((receipt: AuthorityReceipt | null) => void | Promise<void>) | undefined
  let readiness: (() => Promise<void>) | undefined
  const counts = { environments: 0, prompts: 0, synthetics: 0, interrupts: 0, creates: 0, receipts: 0 }
  const sessions = new Map(["ses_test_coordinator", "ses_test_actor"].map(id => [id, { id, title: id, projectID: "test-project", agent: "build", location: { directory: f.project } }]))
  const registrations = new Map<string, { definition: any; handlers: Record<string, (input: any, context: any) => Promise<any>> }>()
  const tools = new Map<string, any>()
  const invoke = async (id: string, method: string, raw: unknown) => {
    const rpc = registrations.get(id)!
    const schema = rpc.definition.methods[method].input
    const value = typeof schema.parse === "function" ? schema.parse(raw) : raw
    const result = await rpc.handlers[method](value, { signal: new AbortController().signal,
      error: (_name: string, _message: string, data: unknown) => Object.assign(new Error("declared native rejection"), data) })
    if (result instanceof Error) throw result
    if (id === "codenomad.missions.authority" && method === "receipt") {
      counts.receipts++
      // Native wire decoding detaches the immutable product result. Fault hooks
      // perturb that decoded RPC reply, NEVER read product storage from the host.
      const decoded = structuredClone(result)
      await receiptRead?.(decoded.receipt)
      return decoded
    }
    return result
  }
  const client: any = {
    rpc: (definition: { id: string }) => new Proxy({}, { get: (_target, method: string) => (raw: unknown) => invoke(definition.id, method, raw) }),
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { await afterSessionGet?.(); const found = sessions.get(sessionID); if (!found) throw new Error("unknown session"); return structuredClone(found) },
      environment: async () => { counts.environments++; await environmentWrite?.() },
      prompt: async () => { counts.prompts++; return {} },
      synthetic: async (input: SessionSyntheticInput) => { counts.synthetics++; return syntheticAcknowledgement(input) },
      interrupt: async () => { counts.interrupts++; if (failInterrupt) throw new Error("private fixture failed interruption"); return { interrupted: true } },
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
      inbox: { list: async () => [], cancel: async () => {} },
      active: async () => { await readiness?.(); return {} }, list: async () => ({ data: [], cursor: {} }),
    },
    shell: { list: async ({ location }: any) => ({ location, data: [] }) },
    form: { list: async ({ location }: any) => ({ location, data: [] }) },
    permission: { request: { list: async ({ location }: any) => ({ location, data: [] }) } },
  }
  const connection: any = { client, assertCurrent() { if (!nativeCurrent) throw new Error("private connection lost") } }
  const manager: CanonicalDurableHostDependencies["manager"] = {
    list: () => [{ id: "workspace" }] as any, getSharedServiceConnection: async () => connection,
    getExistingSharedServiceConnection: () => connection,
    ownsLocation: async (_id, location) => location.directory === f.project,
    getWorktreeIdentityForPath: async (_id, directory) => directory === f.project ? "worktree-fixture" : undefined,
    getSessionEnvironment: async () => { await prepareEnvironment?.(); return { PRIVATE_FRESH: "fixture" } },
    getHostPathForServicePath: async (_id, directory) => directory === f.project ? f.project : undefined,
  }
  const auth = new AuthManager({ configPath: f.descriptor.scope.configIdentity, username: "human", password: "private-fixture-password", generateToken: false }, pino({ level: "silent" }))
  const session = auth.createSession("human")
  const request = { headers: { cookie: `${auth.getCookieName()}=${session.id}` } } as FastifyRequest
  const channel: QualifiedNativeMissionChannel = {
    parent: { readStagingScope: () => ({ privateRoot: f.storage, descriptor: f.descriptor }) }, bridge: f.nativeBridge,
    scope: { namespace, projectID: "test-project", projectCanonical: f.project },
    assertCurrent: () => { if (!nativeCurrent) throw new Error("injected native proof unavailable"); return true },
    assertFamilyClaimCurrent: entry => { if (!claimCurrent || entry.claim !== claim || entry.family !== family) throw new Error("injected native claim unavailable"); return true },
  }
  const deps = { nativeHost: { open: async () => channel }, auth, manager, workspaceID: "workspace", fence: new WorktreeDeletionFence(), familyClaims: [{ family, claim }] }
  const composed = assembleCanonicalDurableMissionsHost(deps, channel, f.files)
  let humanCapture: DurableMissionsHost["captureHumanIntent"]
  const context: DurableMissionsContext = {
    location: { directory: f.project, project: { id: "test-project", canonical: f.project } }, storage,
    agent: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
    session: { get: client.session.get, prompt: client.session.prompt, synthetic: client.session.synthetic,
      create: async () => { counts.creates++; throw new Error("new managed actor unavailable") },
      hook: async () => ({ dispose: async () => {} }) },
    tool: { transform: async (callback: any) => { callback({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }); return { dispose: async () => {} } } },
    rpc: { register: async (definition: any, handlers: any) => { registrations.set(definition.id, { definition, handlers }); return { dispose: async () => {}, events: { emit: async () => {} } } } },
  } as unknown as DurableMissionsContext
  const dispose = await setupDurableMissionsPlugin(context, { ...composed.host,
    captureHumanIntent: signed => (humanCapture ?? composed.host.captureHumanIntent!)(signed) })
  const signal = new AbortController().signal
  const create = (originSignal = signal) => composed.actions.create(request, { requestID: "private-create", coordinatorSessionId: "ses_test_coordinator",
    payload: { objective: "Real canonical coupling", template: "custom", prepared: true } }, originSignal)
  const action = async (method: string, payload: unknown, requestID = `private-${method}-${Date.now()}`, originSignal = signal) => {
    const host = (await composed.authority.read())!
    const snapshot = await new MissionJournal(storage, "test-project", f.project).snapshot()
    return composed.actions.execute(request, { method, payload, requestID, expectedRevision: snapshot.missions[0].revision, expectedHostRevision: host.revision }, originSignal)
  }
  const runTool = async (name: string, raw: unknown, sessionID = "ses_test_coordinator") => JSON.parse((await tools.get(name)!.execute(raw,
    { sessionID, messageID: "msg_fixture_tool", id: "call_fixture", progress: async () => {} })).content)
  return { ...f, ...composed, deps, channel, client, manager, storage, nativeStore, counts, sessions, tools, request, create, action, runTool, signal, familyStore,
    setHumanCapture(callback: NonNullable<DurableMissionsHost["captureHumanIntent"]>) { humanCapture = callback },
    // AuthManager has no expiry mutation API. Test-only invalidation of its real
    // SessionManager entry keeps the original cookie unchanged (no fake auth).
    expireHumanSession() { (auth as unknown as { sessionManager: { sessions: Map<string, unknown> } }).sessionManager.sessions.delete(session.id) },
    disposePlugin: dispose,
    cleanup: async () => { await dispose(); await f.cleanup() },
    setEnvironmentPreparation(callback: () => Promise<void>) { prepareEnvironment = callback }, setEnvironmentWrite(callback: () => Promise<void>) { environmentWrite = callback },
    setSessionGet(callback: () => Promise<void>) { afterSessionGet = callback }, setReceiptRead(callback: (receipt: AuthorityReceipt | null) => void | Promise<void>) { receiptRead = callback },
    setReadinessPreparation(callback: () => Promise<void>) { readiness = callback },
    loseNative() { nativeCurrent = false }, loseClaim() { claimCurrent = false }, failStop() { failInterrupt = true },
    async changeGeneration() { const doc = JSON.parse(await readFile(f.recordFile, "utf8")); const { randomUUID } = await import("node:crypto"); doc.generation = randomUUID(); await writeFile(f.recordFile, JSON.stringify(doc)) },
  }
}

// Only the fake SDK produces this native-shaped reply. Copy the received input;
// never manufacture lifecycle correlation or repair an invalid/missing message ID.
export function syntheticAcknowledgement(input: SessionSyntheticInput): SessionInboxSynthetic {
  if (!input.id || !input.delivery) throw new Error("Fixture requires explicit synthetic ID and delivery")
  return { id: input.id, sessionID: input.sessionID, type: "synthetic", delivery: input.delivery, time: { created: 100 },
    payload: { text: input.text, ...(input.description != null ? { description: input.description } : {}),
      ...(input.metadata !== undefined ? { metadata: structuredClone(input.metadata) } : {}) } }
}

export function existingRootExecution(): { executionMode: MissionTaskExecutionMode } {
  return { executionMode: { kind: "independent", reason: "existing-root",
    explanation: "Exercise the existing isolated root actor's signed environment and admission fences rather than declare a native subagent task." } }
}
