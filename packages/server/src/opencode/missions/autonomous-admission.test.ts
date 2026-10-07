import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/schema/location"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { NativeMissionAuthority } from "../../missions/authority-core"
import { NativeMissionAuthorityStore } from "../../missions/authority-store"
import { authoritySignerDigest, MISSION_AUTHORITY_POLICY, type AuthorityBinding, type ProvisionedAuthoritySigner } from "../../missions/authority-protocol"
import type { MissionJsonValue, MissionMap, MissionSnapshot } from "../../missions/model"
import { assignmentInput, reportInput } from "../../missions/inputs"
import { acquireMissionNativeService } from "./native-service-adapter"
import { admitAutonomousMissionInput } from "./autonomous-admission"
import { reconstructAutonomousMissionCommand, type AutonomousMissionCommand } from "./autonomous-contract"

// Structural owner/root/service injection only; the separate .test.mjs exercises
// real native service effects. This fixture is not a native ownership grant proof.
async function fixture() {
  const root = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "missions-native-admission-"))
  const configYamlPath = path.join(root, "config.yaml")
  const setEnvironment = (value: string) => writeFile(configYamlPath, `server:\n  environmentVariables:\n    MARKER: ${value}\n    OPENCODE_DB: ignored\n    CODENOMAD_SERVER_PASSWORD: ignored\n`)
  await setEnvironment("first")
  const scope: AuthorityBinding = { authorityID: "authority", keyID: "key", profileID: "profile", executionHost: "local",
    namespace: randomUUID(), projectID: "project", projectCanonical: root, missionID: "msn_owned", coordinatorSessionID: "ses_coordinator",
    roots: [{ mode: "git", directory: root, family: "family", checkout: "checkout" }] }
  const location = Schema.decodeUnknownSync(Location.Info)({ directory: root, project: { id: scope.projectID, directory: root, canonical: root } })
  const mission: MissionMap = { version: 1, id: scope.missionID, projectID: scope.projectID, projectCanonical: root,
    objective: "Bounded native work", template: "custom", status: "active", runState: "running", coordinatorSessionId: scope.coordinatorSessionID,
    actors: [scope.coordinatorSessionID, "ses_worker"].map((sessionId, index) => ({ sessionId, kind: index ? "specialist" : "coordinator",
      managed: true, title: sessionId, roles: [], location: { directory: root }, joinedAt: 1 })),
    tasks: [{ id: "tsk_work", key: "work", title: "Work", brief: "Inspect", role: "worker", blockedBy: [], status: "dispatching",
      actorSessionId: "ses_worker", admissionId: "msg_assignment", delivery: "queue", execution: { agent: "worker" },
      createdAt: 1, updatedAt: 1, outstandingExecution: false }],
    reports: [], frontier: [], claims: [], createdAt: 1, updatedAt: 1, revision: 1, history: [], historyTruncated: false }
  const snapshot = (): MissionSnapshot => ({ version: 1, projectID: scope.projectID, generatedAt: 1, missions: [structuredClone(mission)], discardedEvents: 0 })
  const values = new Map<string, MissionJsonValue>()
  const store = new NativeMissionAuthorityStore({ get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) }, scan: async () => ({ entries: [] }) }, scope.projectID, root)
  scope.namespace = await store.initialize()
  const key = generateKeyPairSync("ed25519")
  const signer: ProvisionedAuthoritySigner = { ...scope, publicKey: key.publicKey, provisioningGeneration: "generation", policy: MISSION_AUTHORITY_POLICY,
    qualification: "qualified" as const }
  await store.transaction(async doc => { doc.grants.push({ ...scope, version: 1, epoch: 1, signerDigest: authoritySignerDigest(key.publicKey), state: "active", sendsEnabled: true }) })
  const authority = new NativeMissionAuthority(store, { assertActive() {}, readSigners: async () => [signer], assertSignerCurrent: () => true,
    observeMission: async () => ({ missionID: mission.id, coordinatorSessionID: mission.coordinatorSessionId, revision: mission.revision,
      status: mission.status, runState: mission.runState ?? "running", controlPending: false, roots: scope.roots }), assertJournalCapacity: async () => {} })
  let current = true, environmentHook: (() => void | Promise<void>) | undefined, failSend = false, moved = false
  const effects: Array<{ kind: string; id?: string; variables?: Record<string, string> }> = []
  const service = {
    get: (id: string) => Effect.sync(() => Schema.decodeUnknownSync(Session.Info)({ id, projectID: scope.projectID,
      ...(id === "ses_worker" ? { agent: "worker" } : {}), location: { directory: moved ? `${root}-moved` : root },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })),
    inbox: () => Effect.succeed([]),
    environment: (input: { variables: Record<string, string> }) => Effect.tryPromise(async () => {
      effects.push({ kind: "environment", variables: { ...input.variables } }); await environmentHook?.(); return { ...input.variables }
    }),
    prompt: (input: AutonomousMissionCommand["input"]) => send("user", input),
    synthetic: (input: AutonomousMissionCommand["input"]) => send("synthetic", input),
  }
  function send(kind: string, input: AutonomousMissionCommand["input"]) {
    return Effect.sync(() => {
      effects.push({ kind, id: input.id })
      if (failSend) throw new Error("Uncertain native acknowledgement")
      return Schema.decodeUnknownSync(SessionInbox.Info)({ id: input.id, sessionID: input.sessionID, type: kind,
        payload: { text: input.text, metadata: input.metadata }, delivery: input.delivery, time: { created: 1 } })
    })
  }
  const lifetime = await Effect.runPromise(Scope.make())
  const native = await Effect.runPromise(acquireMissionNativeService().pipe(Effect.provideService(Context.Service("@opencode/Session"), service),
    Effect.provideService(Context.Service("@opencode/Location"), location), Effect.provideService(Scope.Scope, lifetime)))
  let ownerGuard: () => true = () => { assert(current, "owner retired"); return true }
  const admit = (command: unknown = { kind: "prompt", input: assignmentInput(mission, mission.tasks[0]) }) => admitAutonomousMissionInput({
    context: { location, session: { get: native.get } }, journal: { snapshot: async () => snapshot() }, authority, scope,
    profile: { profileID: scope.profileID, executionHost: scope.executionHost, configYamlPath }, command, signal: new AbortController().signal,
    executionHost: { environment: { PATH: "native-host", OPENCODE_SERVER_PASSWORD: "ignored" } }, native,
    assertCurrent: () => ownerGuard(), withGate: operation => operation(), resolveRoot: async () => scope.roots[0],
  })
  return { mission, scope, snapshot, effects, admit, setEnvironment, configYamlPath,
    setOwnerGuard(guard: () => true) { ownerGuard = guard },
    onEnvironment(hook: () => void | Promise<void>) { environmentHook = hook }, retire() { current = false }, move() { moved = true }, failSend() { failSend = true },
    async changeGrant(mode: "epoch" | "revoke") { await store.transaction(async doc => {
      if (mode === "epoch") doc.grants[0].epoch++
      else doc.grants[0].state = "revoked"
    }) },
    async dispose() { await Effect.runPromise(Scope.close(lifetime, Exit.void)); await rm(root, { recursive: true, force: true }) } }
}

test("canonical ordinary mission send applies a complete fresh native environment; report uses native synthetic", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.admit()).admissionID, "msg_assignment")
    assert.deepEqual(f.effects.map(item => item.kind), ["environment", "user"])
    assert.deepEqual(f.effects[0].variables, { PATH: "native-host", MARKER: "first" })
    await f.setEnvironment("second")
    const report = { id: "report_1", taskKey: "work", sessionId: "ses_worker", outcome: "completed" as const,
      summary: "Done", evidence: [], next: [], createdAt: 2 }
    f.mission.tasks[0].report = report
    await f.admit({ kind: "synthetic", input: reportInput(f.mission, report) })
    assert.equal(f.effects[2].variables?.MARKER, "second")
    assert.equal(f.effects[3].kind, "synthetic")
  } finally { await f.dispose() }
})

test("high-level owner rejects async and nonliteral approval before any native effect", async () => {
  const f = await fixture()
  let assimilated = 0
  try {
    for (const guard of [() => false, () => undefined, () => Promise.resolve(true), () => Promise.reject(new Error("owner retired")),
      () => ({ then() { assimilated++; throw new Error("must not assimilate") } })]) {
      f.setOwnerGuard(guard as unknown as () => true)
      await assert.rejects(f.admit(), /policy-unqualified/)
    }
    assert.equal(f.effects.length, 0)
    assert.equal(assimilated, 0)
    // Also catch a formerly synchronous owner turning async AFTER environment.
    f.setOwnerGuard(() => true)
    f.onEnvironment(() => f.setOwnerGuard((() => Promise.reject(new Error("late owner retirement"))) as unknown as () => true))
    await assert.rejects(f.admit(), /policy-unqualified/)
    assert.deepEqual(f.effects.map(item => item.kind), ["environment"])
  } finally { await f.dispose() }
})

test("tampering and unknown tasks fail reconstruction before effects", async () => {
  const f = await fixture()
  try {
    const command = { kind: "prompt", input: { ...assignmentInput(f.mission, f.mission.tasks[0]), text: "Injected text" } }
    await assert.rejects(f.admit(command), /binding-mismatch/)
    assert.throws(() => reconstructAutonomousMissionCommand(f.snapshot(), f.scope,
      { kind: "synthetic", input: { ...command.input, metadata: { "codenomad.mission": { version: 1, missionID: f.mission.id, kind: "report", taskKey: "missing" } } } }))
    assert.deepEqual(f.effects, [])
  } finally { await f.dispose() }
})

for (const mode of ["pause", "retire", "move", "epoch", "revoke", "read-error", "lost-ack"] as const) {
  test(`${mode} fences later sends and never retries uncertain native effects`, async () => {
    const f = await fixture()
    try {
      if (mode === "pause") f.onEnvironment(() => { f.mission.runState = "paused" })
      if (mode === "retire") f.onEnvironment(() => f.retire())
      if (mode === "move") f.onEnvironment(() => f.move())
      if (mode === "epoch" || mode === "revoke") f.onEnvironment(() => f.changeGrant(mode))
      if (mode === "read-error") await writeFile(f.configYamlPath, "server: { environmentVariables: [invalid] }")
      if (mode === "lost-ack") f.failSend()
      await assert.rejects(f.admit())
      assert.equal(f.effects.filter(item => item.kind === "user").length, mode === "lost-ack" ? 1 : 0)
      assert.equal(f.effects.filter(item => item.kind === "environment").length, mode === "read-error" ? 0 : 1)
    } finally { await f.dispose() }
  })
}
