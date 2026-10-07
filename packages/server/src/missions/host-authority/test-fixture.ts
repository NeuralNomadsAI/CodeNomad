// Isolated UNIT fixture, not a production native attestation/old-writer proof.
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { lstatSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import type { FastifyRequest } from "fastify"
import { canonicalScope } from "../../host-lifetime/protocol"
import { NativeMissionAuthorityStore } from "../authority-store"
import { NativeMissionAuthority } from "../authority-core"
import { MISSION_AUTHORITY_POLICY, canonicalAuthority, authorityDigest, type AuthorityBinding, type AuthorityIntent } from "../authority-protocol"
import { physical, ProtectedAuthorityFiles, type PrivateFilePolicy } from "./private-files"
import { HostAuthorityAdmissions, type ManagedAuthorityObservation, type PrivateManagedAuthorityBridge } from "./qualification"
import { ProtectedHostAuthority } from "./store"
import type { NativeMirrorObservation } from "./registry"
import { controlOperationID } from "../receipt-identity"
import type { MissionLifecycleOperation } from "../lifecycle-model"
import type { AuthorityEffectIntent } from "../authority-core"

export const structuralTestPolicy: PrivateFilePolicy = {
  async verify(file, directory) { structuralTestPolicy.verifySync(file, directory) },
  verifySync(file, directory) {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error("unsafe test leaf")
  },
}
export async function fixture(options: { bridge?: boolean; policy?: PrivateFilePolicy; freshMission?: boolean } = {}) {
  const root = await mkdtemp(path.join(process.platform === "win32" ? "C:/Users/Admin/AppData/Local/Temp/opencode" : tmpdir(), "host-authority-"))
  const profile = path.join(root, "profile"), storage = path.join(root, "private"), project = path.join(root, "project")
  await Promise.all([profile, storage, project].map(value => mkdir(value, { mode: 0o700 })))
  const descriptor = { scope: canonicalScope("test", path.join(profile, "config.yaml"), root, root),
    physicalProfile: physical(profile), executionHost: "fixture-execution-host" }
  const files = new ProtectedAuthorityFiles(storage, descriptor, options.policy ?? structuralTestPolicy)
  let authEnabled = true, authenticated = true, owned = true, nativeCurrent = true
  const hostGeneration = randomUUID()
  let afterHandshake: (() => void | Promise<void>) | undefined
  let modifyObservation: ((value: ManagedAuthorityObservation) => void) | undefined
  const proofs = new WeakMap<object, ManagedAuthorityObservation>()
  const nativeBridge: PrivateManagedAuthorityBridge = {
    async readDiscoveryBoundary() { return { globalDirectory: path.join(root, "native-config"), configDigest: "b".repeat(64) } },
    async handshake(input) {
      const proof = Object.freeze({})
      const before = [{ id: "retired-test-writer", incarnationID: "retired-incarnation", artifactDigest: "d".repeat(64), kind: "legacy" as const, state: "active" as const }]
      const after = [{ id: "private-test-writer", incarnationID: "new-incarnation", artifactDigest: "a".repeat(64), kind: "managed" as const, state: "active" as const }]
      const disposals = [{ registrationID: "retired-test-writer", incarnationID: "retired-incarnation", receiptID: "private-test-disposal" }]
      const value: ManagedAuthorityObservation = { nonce: input.nonce, descriptor: structuredClone(input.descriptor), hostGeneration,
        attestationID: "private-injected-test-attestation", provisioningGeneration: input.provisioningGeneration, signerDigest: input.signerDigest,
        hostOwner: { pid: process.pid, startIdentity: "test-only-host-start" }, backendOwner: { pid: process.pid, startIdentity: "test-only-backend-start" },
        writer: { registrationID: "private-test-writer", incarnationID: "new-incarnation", artifactDigest: "a".repeat(64), daemonStorageID: "test-isolated-native-storage",
          namespace: input.binding.namespace, projectID: input.binding.projectID, projectCanonical: input.binding.projectCanonical,
          coordinatorSessionID: input.binding.coordinatorSessionID, roots: structuredClone(input.binding.roots) },
        quiescence: { actionID: "test-explicit-quiescence", discoveryRoot: path.join(root, "native-config"), configDigest: "b".repeat(64),
          inventoryDigest: authorityDigest({ before, after, disposals }), excludedWriterIDs: ["retired-test-writer"], remainingLegacyWriterIDs: [],
          policy: "explicit-human-quiescence-v1", before, after, disposals } }
      modifyObservation?.(value)
      proofs.set(proof, value)
      await afterHandshake?.()
      return proof
    },
    verify(proof) { if (!proof || typeof proof !== "object" || !proofs.has(proof)) throw new Error("unknown proof"); return proofs.get(proof)! },
    assertCurrent(proof) { if (!nativeCurrent || !proof || typeof proof !== "object" || !proofs.has(proof)) throw new Error("native trust lost"); return true },
  }
  const auth = { isAuthEnabled: () => authEnabled, getSessionFromRequest: () => authenticated ? { username: "fixture-human", sessionId: "fixture-auth-session" } : null }
  const gate = { async withOwned<T>(binding: AuthorityBinding, operation: (check: () => true) => Promise<T>): Promise<T> {
    const fence = (): true => {
      if (!owned || binding.projectCanonical !== project || binding.projectID !== "test-project"
        || binding.roots.length !== 1 || binding.roots[0].directory !== project || binding.coordinatorSessionID !== "ses_test_coordinator") throw new Error("ownership lost")
      return true
    }
    fence(); return operation(fence)
  } }
  // No startup/provisioning exists in this injected ownership reader.
  const admissions = new HostAuthorityAdmissions(auth, { ...gate, withExisting: gate.withOwned }, descriptor, options.bridge === false ? undefined : nativeBridge)
  let observation: NativeMirrorObservation | undefined, nativeReads = 0, betweenNativeReads: (() => void) | undefined
  const reader = { async read(_body: AuthorityIntent) {
    nativeReads++
    if (!observation) throw new Error("unobserved native state")
    const value = structuredClone(observation)
    betweenNativeReads?.()
    return value
  } }
  const host = new ProtectedHostAuthority(files, admissions, reader)
  const data = new Map<string, unknown>()
  const nativeStorage = { async get(key: string) { return structuredClone(data.get(key)) as any },
    async set(key: string, value: unknown) { data.set(key, structuredClone(value)) }, async scan() { return { entries: [] } } }
  const nativeStore = new NativeMissionAuthorityStore(nativeStorage, "test-project", project)
  await nativeStore.initialize()
  const nativeDocument = await nativeStore.read()
  const target = { namespace: nativeDocument.namespace, projectID: "test-project", projectCanonical: project, missionID: "msn_test",
    coordinatorSessionID: "ses_test_coordinator", roots: [{ mode: "directory-only" as const, directory: project }] }
  let revision = options.freshMission ? 0 : 1, missionExists = !options.freshMission
  let runState: "prepared" | "running" | "paused" | "stopped" = "prepared", controlPending = false
  let control: MissionLifecycleOperation | undefined
  const core = new NativeMissionAuthority(nativeStore, {
    assertActive() {}, readSigners: () => host.readSigners(), assertSignerCurrent: signer => host.assertSignerCurrent(signer),
    observeMission: async () => missionExists ? ({ ...target, revision, status: "active", runState, controlPending, control }) : undefined,
    assertJournalCapacity: async () => {},
  })
  const request = {} as FastifyRequest
  const prepare = () => host.prepare(request, target, null)
  const body = async (method: AuthorityIntent["method"], payload: unknown, overrides = {}) => {
    const state = (await host.read())!
    return { ...state.binding, version: 1, policy: MISSION_AUTHORITY_POLICY, expectedRevision: revision,
      epoch: state.epoch + (method === "adopt" ? 1 : 0), requestID: randomUUID(), method, payload, ...overrides }
  }
  const apply = async (intent: AuthorityEffectIntent) => {
    revision++
    if (intent.method === "create") missionExists = true
    if (intent.method === "delete") missionExists = false
    if (intent.method === "lifecycle") {
      runState = intent.payload.action === "start" ? "running" : intent.payload.action === "pause" ? "paused" : "stopped"
      control = { ...intent, id: controlOperationID(intent.missionID, intent.requestID), action: intent.payload.action,
        targets: [{ sessionID: target.coordinatorSessionID, location: { directory: project } }], pending: [], completedRevision: revision }
    }
    return { missionID: target.missionID, revision,
      ...(intent.method === "lifecycle" ? { operationID: controlOperationID(intent.missionID, intent.requestID) } : {}) }
  }
  const execute = async (input: unknown) => {
    const before = (await host.read())!
    const signed = await host.sign(request, input, before.revision)
    const signer = (await host.read())!.signer!
    const result = await core.execute(signed, { expectedSigner: signer, apply }, new AbortController().signal)
    const nativeState = await core.state(target.missionID)
    observation = { operation: result, revision, terminal: nativeState.terminal, pendingRequestIDs: nativeState.pendingRequestIDs }
    const pending = (await host.read())!
    await host.accept(request, pending.pendingDigest!, pending.revision)
    return signed
  }
  return { root, profile, storage, project, descriptor, files, admissions, host, nativeBridge, core, request, target, prepare, body, execute, apply,
    cleanup: () => rm(root, { recursive: true, force: true }),
    loseAuth() { authenticated = false }, disableAuth() { authEnabled = false }, loseOwnership() { owned = false }, loseNative() { nativeCurrent = false },
    afterHandshake(action: () => void | Promise<void>) { afterHandshake = action }, observationFault(action: (value: ManagedAuthorityObservation) => void) { modifyObservation = action },
    nativeReads: () => nativeReads, setObservation(value: NativeMirrorObservation) { observation = value },
    betweenNativeReads(action: () => void) { betweenNativeReads = action },
    recordFile: path.join(files.directory, "missions-authority.json"), markerFile: path.join(files.directory, "missions-authority.identity"),
    lockDirectory: path.join(files.directory, "missions-authority-cas"), readRaw: () => files.read(), canonical: canonicalAuthority,
  }
}
