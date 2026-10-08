import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { DateTime } from "effect"
import { authorityDigest, authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY,
  type ProvisionedAuthoritySigner } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { deriveRecurrenceChild, recurrenceEffectID, recurrenceHumanRequestID, recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY, type RecurrenceStandingIntent,
  type SignedRecurrenceStandingIntent } from "../../missions/recurrence-authority-contract"
import { recurrenceMessageID, recurrencePassageID } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { RecurrenceAuthority } from "../../missions/recurrence-authority-core"
import { physical } from "../../missions/host-authority/private-files"
import { NativeRecurrenceAuthorityStore, type RecurrenceAuthorityDocument } from "../../missions/recurrence-authority-store"
import type { MissionStorage } from "../../missions/journal"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import { applyNativeStandingDecision, nativeRecurrenceAdapter, type NativeStandingSigner } from "./native-recurrence-adapter"
import { reconcileNativeRecurrenceRoot } from "./native-recurrence-admission"
import { admitNativeRecurrencePassage } from "./native-recurrence-admission"
import { missionProfileRoles } from "../../missions/playbook-profiles"

for (const template of ["custom", "pocock-fix-bug", "wayfinder"] as const) test(`native ${template} standing human CAS checks signer, protected decision, physical family and native head`, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "recurrence-native-"))
  try {
    execFileSync("git", ["init", "-q", temporary])
    const checkout = realpathSync(temporary), nested = path.join(checkout, "packages", "server")
    await mkdir(nested, { recursive: true })
    const directory = template === "custom" ? nested : checkout, family = await readFamilyAuthorityIdentity(directory)
    const root = { mode: "git" as const, directory, checkout: physical(checkout), family }
    const scope = { namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9", projectID: "project",
      projectCanonical: directory, profileID: "profile", executionHost: "host", scheduleID: "watch", daemonStorageID: "native" }
    const keys = generateKeyPairSync("ed25519")
    const signer: ProvisionedAuthoritySigner = { ...scope, authorityID: "authority", keyID: "key", roots: [root],
      publicKey: keys.publicKey, provisioningGeneration: "generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }
    const config = { template, consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: scope.profileID,
      notes: "  Preserve optional <working notes> & whitespace\n  ",
      executionHost: scope.executionHost, roots: [root], profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
        roles: Object.fromEntries(missionProfileRoles[template].map(role => [role,
          { agent: "worker", model: { providerID: "provider", id: "model" } }])) },
      taskMode: "native", watchedConversationIDs: [], publication: { policy: "disabled", conversationIDs: [] } } as const
    const profile = { profileID: scope.profileID, executionHost: scope.executionHost,
      configYamlPath: path.join(directory, "config.yaml") }
    const values = new Map<string, unknown>([[`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, scope.namespace]])
    let live = true, human = true, evolving = false, protectedParent: SignedRecurrenceStandingIntent | undefined
    let protectedHead: RecurrenceAuthorityDocument | null = null
    const store = new NativeRecurrenceAuthorityStore({
      get: async key => values.get(key) as Awaited<ReturnType<MissionStorage["get"]>>,
      set: async (key, value, current) => { current?.(); values.set(key, structuredClone(value)) },
      scan: async () => { throw Error("No broad scans") },
    }, scope)
    const sourceKey = "native-schedule"
    values.set(sourceKey, { version: 1, projectID: scope.projectID, projectCanonical: directory, id: scope.scheduleID,
      revision: 0, scheduleRevision: 0, createdAt: 1, state: "paused", config: JSON.parse(canonicalAuthority(config)),
      lastDaily: null, settledCount: 0, cursors: [], pending: null, history: [] })
    const provider = { store, daemonStorageID: scope.daemonStorageID, sourceKey, location: {
      directory, projectID: scope.projectID, projectCanonical: directory, sessionID: "ses_owner" },
      assertCurrent: () => { assert(live); return true },
      readCurrent: (key: string) => values.get(key),
      read: () => store.read(),
      transact: async (_current: () => true, operation: () => Promise<unknown>) => operation(),
    } as unknown as NativeRecurrenceAuthorityProvider
    const trust: NativeStandingSigner = {
      readSigners: async () => [signer],
      assertSignerCurrent: snapshot => { assert.equal(snapshot.signerDigest, authoritySignerDigest(signer.publicKey)); assert(live); return true },
      captureHumanIntent: parent => () => { assert(human); assert.deepEqual(parent, protectedParent); return true },
      assertProtectedCurrent: request => {
        assert(live)
        assert.deepEqual(request.parent, protectedParent)
        assert.deepEqual(request.ledger, evolving ? values.get(store.key) ?? null : protectedHead)
        return true
      },
    }
    let invocation: import("./native-recurrence-adapter").NativeRecurrenceInvocation | undefined
    const input = { provider, signer: trust, owner: { daemonStorageID: scope.daemonStorageID, namespace: scope.namespace,
       assertCurrent: () => { assert(live); return true as const } },
      invocation: () => invocation,
    }
    const signed = (action: RecurrenceStandingIntent["action"], before: RecurrenceAuthorityDocument | null): SignedRecurrenceStandingIntent => {
      const epoch = (before?.parent.body.epoch ?? 0) + 1
      const body: RecurrenceStandingIntent = { ...scope, authorityID: signer.authorityID, keyID: signer.keyID, roots: [root],
        version: 1, policy: RECURRENCE_AUTHORITY_POLICY, action, scheduleRevision: 0, epoch,
        requestID: recurrenceHumanRequestID(scope.scheduleID, epoch, action),
        expectedRevision: before?.revision ?? null, provisioningGeneration: signer.provisioningGeneration,
        signerDigest: authoritySignerDigest(signer.publicKey), config: JSON.parse(canonicalAuthority(config)),
        configDigest: authorityDigest(config), profileSource: profile,
        budgets: { effects: 4, nativeCalls: 0, inboxMessages: 0, publications: 0 } }
      return { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
    }
    const authorize = async (action: RecurrenceStandingIntent["action"], before: RecurrenceAuthorityDocument | null) => {
      protectedHead = before; protectedParent = signed(action, before)
      return applyNativeStandingDecision(input, protectedParent, new AbortController().signal)
    }
    const originalSource = structuredClone(values.get(sourceKey)) as Record<string, unknown>
    values.set(sourceKey, { ...originalSource, scheduleRevision: 1 })
    await assert.rejects(authorize("authorize", null), /Invalid recurrence storage identity/)
    assert.equal(values.get(store.key), undefined)
    values.set(sourceKey, originalSource)
    const first = await authorize("authorize", null)
    assert.equal(first.revision, 0)
    const source = structuredClone(values.get(sourceKey)) as Record<string, unknown>
    const due = { kind: "manual" as const, requestID: "request", expectedRevision: 0, at: 1 }
    const passageID = recurrencePassageID(stableToken(`${scope.projectID}\0${directory}`, 24), scope.scheduleID, 0, due)
    const pendingSource = { ...source, revision: 1, pending: { passage: { id: passageID,
      messageID: recurrenceMessageID(passageID), scheduleRevision: 0, createdAt: 1, due }, admission: null } }
    const finiteValues = new Map<string, unknown>()
    const finiteStorage: MissionStorage = {
      get: async key => finiteValues.get(key) as Awaited<ReturnType<MissionStorage["get"]>>,
      set: async (key, value, fence) => { fence?.(); finiteValues.set(key, structuredClone(value)) },
      scan: async ({ prefix, after, limit }) => ({ entries: [...finiteValues].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)
        .map(([key, value]) => ({ key, value: value as Awaited<ReturnType<MissionStorage["get"]>> & {} })) }),
    }
    writeFileSync(profile.configYamlPath, "server:\n  environmentVariables:\n    MARKER: fresh\n")
    values.set(sourceKey, pendingSource)
    evolving = true
    let nativeSession: ReturnType<typeof makeSession> | undefined, nativeCreations = 0, nativeMessages = 0
    let afterCreate = () => {}
    function makeSession(request: { id: string; title: string; location: { directory: string }; metadata: Record<string, unknown>;
      agent: string; model: { providerID: string; id: string } }) {
      return { ...request, model: { ...request.model, variant: "default" }, projectID: scope.projectID }
    }
    const nativeService = { location: { directory, project: { id: scope.projectID, canonical: directory } },
      assertCurrent: () => { assert(live); return true as const },
      get: async () => { if (!nativeSession) throw new Error("Missing native session"); return nativeSession },
      create: async (request: Parameters<typeof makeSession>[0], _options: unknown, current: () => true) => {
        current(); nativeCreations++; nativeSession = makeSession(request); afterCreate(); return nativeSession
      },
      environment: async (request: { variables: Record<string, string> }, _options: unknown, current: () => true) => {
        current(); assert.equal(request.variables.MARKER, "fresh")
      },
      admit: async (command: { input: { id: string; sessionID: string; text: string; metadata: Record<string, unknown>; delivery: string } },
        _options: unknown, current: () => true) => {
        current(); nativeMessages++
        assert.equal(command.input.text, config.consigne, "notes stay out of the bounded raw start message")
        return { id: command.input.id, sessionID: command.input.sessionID, type: "synthetic", delivery: command.input.delivery,
          payload: { text: command.input.text, description: "CodeNomad recurring mission start", metadata: command.input.metadata },
          time: { created: DateTime.makeUnsafe(2) } }
      },
    }
    const full = await admitNativeRecurrencePassage({ document: pendingSource as never, provider, signer: trust,
      owner: input.owner, storage: finiteStorage, native: nativeService as never,
      profile, signal: new AbortController().signal, settlementSignal: new AbortController().signal,
      beforeEffect: async () => () => { assert(live); return true as const }, now: () => 2 })
    assert.equal(full.kind, "accepted")
    const created = [...finiteValues.values()].find(value => (value as { type?: string }).type === "mission.created") as { template: string; notes?: string }
    assert.equal(created.template, template, "finite MissionControl.create must reuse the frozen playbook")
    assert.equal(created.notes, config.notes)
    assert.equal(full.messageID, pendingSource.pending.passage.messageID)
    assert.equal(nativeCreations, 1)
    assert.equal(nativeMessages, 1)
    assert.equal((await store.read())?.child?.effects.length, 3)
    const admittedLedger = (await store.read())!
    assert(admittedLedger.child?.effects.every(item => item.receipt?.outcome === "applied"))
    await assert.rejects(new RecurrenceAuthority(store, nativeRecurrenceAdapter(input)).settle(
      admittedLedger.child!.grant.grantID, admittedLedger.revision, new AbortController().signal), /observation-unavailable/,
    "three real native effect receipts are admission evidence, not a terminal passage")
    assert.deepEqual(await store.read(), admittedLedger, "failed terminal observation cannot archive or advance the next passage")
    await assert.rejects(admitNativeRecurrencePassage({ document: pendingSource as never, provider, signer: trust,
      owner: input.owner, storage: finiteStorage, native: nativeService as never,
      profile, signal: new AbortController().signal, settlementSignal: new AbortController().signal,
      beforeEffect: async () => () => { assert(live); return true as const } }))
    assert.equal(nativeCreations, 1, "an accepted passage cannot replay native creation")
    values.set(store.key, first)
    finiteValues.clear()
    nativeSession = undefined
    const cancelled = new AbortController()
    afterCreate = () => cancelled.abort()
    await assert.rejects(admitNativeRecurrencePassage({ document: pendingSource as never, provider, signer: trust,
      owner: input.owner, storage: finiteStorage, native: nativeService as never,
      profile, signal: cancelled.signal, settlementSignal: new AbortController().signal,
      beforeEffect: async () => () => { assert(live); return true as const }, now: () => 3 }))
    assert.equal((await store.read())?.child?.effects[0]?.receipt?.outcome, "applied",
      "service-owned evidence signal records the positive native create return after dispatch cancellation")
    assert.equal([...finiteValues.values()].some(value => typeof value === "object" && value !== null
      && (value as { type?: string }).type === "mission.created"), true,
    "the original journal can reconcile after a positive create receipt")
    await assert.rejects(admitNativeRecurrencePassage({ document: pendingSource as never, provider, signer: trust,
      owner: input.owner, storage: finiteStorage, native: nativeService as never,
      profile, signal: new AbortController().signal, settlementSignal: new AbortController().signal,
      beforeEffect: async () => () => { assert(live); return true as const } }))
    assert.equal(nativeCreations, 2, "cancellation cannot replay Session.create")
    evolving = false
    values.set(store.key, first)
    values.set(sourceKey, source)
    const grant = deriveRecurrenceChild(first.parent, pendingSource as never, 1)
    const effect = { kind: "create" as const }
    const operation = { operationID: recurrenceEffectID(grant, effect), effect, receipt: null }
    const child = { parent: first.parent, grant, effects: [operation] }
    const reserved = { ...first, revision: 1, child }
    values.set(store.key, reserved)
    invocation = { operationID: operation.operationID, input: { kind: "create", request: {
      id: grant.coordinatorSessionID, title: "Mission coordinator: Review", location: { directory },
      metadata: { "codenomad.mission": { version: 1, missionID: grant.missionID, kind: "coordinator", role: "coordinator" } },
      agent: "worker", model: { providerID: "provider", id: "model" },
    } } }
    const adapter = nativeRecurrenceAdapter(input)
    const nextParent = `${store.parentKey}/parents/2`
    let nativeCreates = 0
    const enter = () => { adapter.assertEffectCurrent(store, child, operation); nativeCreates++ }
    const original = invocation
    if (original.input.kind !== "create") throw new Error("Invalid fixture invocation")
    invocation = { ...original, input: { kind: "create", request: { ...original.input.request, id: "ses_foreign" } } }
    assert.throws(enter, /binding-mismatch/, "the reserved effect cannot create a different root")
    invocation = original
    const pause = signed("pause", reserved)
    const pausedChild = { ...reserved, revision: 2, parent: pause }
    values.set(nextParent, pause)
    values.set(store.key, pausedChild)
    assert.throws(enter, /authorization-blocked/,
      "Pause before native call entry denies the reservation")
    assert.equal(nativeCreates, 0)
    values.delete(nextParent)
    values.set(store.key, reserved)
    enter()
    values.set(store.key, pausedChild)
    values.set(nextParent, pause)
    invocation.acknowledgement = { operationID: operation.operationID, outcome: "applied", evidenceID: grant.coordinatorSessionID }
    assert.equal((await adapter.observeEffect(child, operation, new AbortController().signal)).receipt.evidenceID,
      grant.coordinatorSessionID, "Pause after native call entry cannot erase its positive original ACK")
    assert.equal(nativeCreates, 1)
    const core = new RecurrenceAuthority(store, adapter)
    evolving = true
    values.set(store.key, reserved)
    await assert.rejects(core.acknowledgeEffect(grant.grantID, operation.operationID, reserved.revision,
      new AbortController().signal), /authorization-blocked/,
    "a torn signed Pause archive cannot donate its epoch to a receipt")
    values.set(store.key, pausedChild)
    const positive = await core.acknowledgeEffect(grant.grantID, operation.operationID, pausedChild.revision,
      new AbortController().signal)
    assert.equal(positive.outcome, "applied", "committed Pause reconciles the original call without a new effect lease")
    assert.equal((await store.read())?.child?.effects[0]?.receipt?.evidenceID, grant.coordinatorSessionID)
    evolving = false
    const acknowledged = { ...reserved, revision: 2, child: { ...child, effects: [{ ...operation,
      receipt: { operationID: operation.operationID, outcome: "applied" as const, evidenceID: grant.coordinatorSessionID } }] } }
    values.delete(nextParent)
    values.set(store.key, acknowledged)
    const journalValues = new Map<string, unknown>()
    const journalStorage: MissionStorage = {
      get: async key => journalValues.get(key) as Awaited<ReturnType<MissionStorage["get"]>>,
      set: async (key, value, fence) => { fence?.(); journalValues.set(key, structuredClone(value)) },
      scan: async ({ prefix, after, limit }) => {
        const entries = [...journalValues].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
          .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)
          .map(([key, value]) => ({ key, value: value as Awaited<ReturnType<MissionStorage["get"]>> & {} }))
        return { entries }
      },
    }
    let createdAgain = 0
    const session = { id: grant.coordinatorSessionID, title: "Mission coordinator: Review", projectID: scope.projectID,
      location: { directory }, agent: "worker", model: { providerID: "provider", id: "model" },
      metadata: invocation.input.kind === "create" ? invocation.input.request.metadata : {} }
    const native = { location: { directory, project: { id: scope.projectID, canonical: directory } },
      assertCurrent: () => { assert(live); return true as const }, get: async () => session,
      create: async () => { createdAgain++; throw new Error("must not replay Session.create") } }
    const reconcile = () => reconcileNativeRecurrenceRoot({ document: pendingSource as never, provider,
      signer: trust, owner: input.owner, storage: journalStorage,
      native: native as never, profile, signal: new AbortController().signal,
      settlementSignal: new AbortController().signal, now: () => 2 })
    assert.equal((await reconcile()).mission.runState, "prepared", "crash between native receipt and journal reconciles")
    const published = [...journalValues]
    assert.equal((await reconcile()).mission.coordinatorSessionId, grant.coordinatorSessionID)
    assert.deepEqual([...journalValues], published, "reconciliation is journal-idempotent")
    const committedPause = signed("pause", acknowledged)
    values.set(nextParent, committedPause)
    values.set(store.key, { ...acknowledged, revision: 3, parent: committedPause })
    assert.equal((await reconcile()).mission.coordinatorSessionId, grant.coordinatorSessionID,
      "committed Pause cannot erase exact positive create metadata recovery")
    assert.equal(createdAgain, 0, "no duplicate native Session.create")
    values.delete(nextParent)
    values.set(store.key, first)
    invocation = undefined
    const paused = await authorize("pause", first)
    assert.equal(paused.parent.body.action, "pause")
    const stopped = await authorize("revoke", paused)
    assert.equal(stopped.parent.body.action, "revoke")
    protectedHead = stopped; protectedParent = signed("authorize", stopped)
    await assert.rejects(applyNativeStandingDecision(input, protectedParent, new AbortController().signal))
    protectedHead = null; await assert.rejects(applyNativeStandingDecision(input, signed("revoke", stopped), new AbortController().signal))
    assert.equal(adapter.assertSignerCurrent({ ...signer, signerDigest: authoritySignerDigest(keys.publicKey) }), true)
    const other = path.join(directory, "unrelated")
    execFileSync("git", ["init", "-q", other])
    renameSync(path.join(checkout, ".git"), path.join(checkout, ".git-original"))
    try {
      writeFileSync(path.join(checkout, ".git"), `gitdir: ${path.join(other, ".git").replaceAll("\\", "/")}\n`)
      // The original family's claim and checkout path are unchanged. Only a
      // fresh Git common-directory read detects this legitimate worktree move.
      assert.throws(() => adapter.assertSignerCurrent({ ...signer, signerDigest: authoritySignerDigest(keys.publicKey) }))
    } finally {
      unlinkSync(path.join(checkout, ".git"))
      renameSync(path.join(checkout, ".git-original"), path.join(checkout, ".git"))
    }
    human = false; await assert.rejects(applyNativeStandingDecision(input, protectedParent, new AbortController().signal))
    human = true; live = false; await assert.rejects(applyNativeStandingDecision(input, protectedParent, new AbortController().signal))
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test("one adapter reuses exact root discovery without caching signer, provider or physical authority", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opencode", "recurrence-root-reuse-"))
  const environment = { ...process.env }
  try {
    for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith("GIT_")) delete process.env[key]
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    process.env.GIT_CONFIG_GLOBAL = path.join(temporary, "absent-global")
    const trace = path.join(temporary, "trace.json")
    process.env.GIT_TRACE2_EVENT = trace.replaceAll("\\", "/")
    const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { windowsHide: true, stdio: "pipe" })
    const directory = path.join(realpathSync(temporary), "checkout"), other = path.join(realpathSync(temporary), "other")
    git(temporary, "init", "-q", directory); git(temporary, "init", "-q", other)
    const family = await readFamilyAuthorityIdentity(directory), otherFamily = await readFamilyAuthorityIdentity(other)
    const root = { mode: "git" as const, directory, checkout: physical(directory), family }
    const scope = { namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9", projectID: "project", projectCanonical: directory,
      profileID: "profile", executionHost: "host", scheduleID: "watch", daemonStorageID: "native" }
    const keys = generateKeyPairSync("ed25519")
    const initial: ProvisionedAuthoritySigner = { ...scope, authorityID: "authority", keyID: "key", roots: [root],
      publicKey: keys.publicKey, provisioningGeneration: "generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }
    let signer = initial, providerLive = true, signerReads = 0
    const store = new NativeRecurrenceAuthorityStore({ get: async () => undefined,
      set: async () => { throw Error("No fixture writes") }, scan: async () => { throw Error("No broad scans") } }, scope)
    const provider = { store, daemonStorageID: scope.daemonStorageID, location: {
      directory, projectID: scope.projectID, projectCanonical: directory },
      assertCurrent: () => { assert(providerLive, "provider-retired"); return true },
    } as unknown as NativeRecurrenceAuthorityProvider
    const trust: NativeStandingSigner = {
      readSigners: async () => { signerReads++; return [signer] },
      assertSignerCurrent: snapshot => { assert.equal(snapshot.provisioningGeneration, signer.provisioningGeneration, "signer-changed"); return true },
      assertProtectedCurrent: () => true, captureHumanIntent: () => () => true,
    }
    const input = { provider, signer: trust, owner: { namespace: scope.namespace, daemonStorageID: scope.daemonStorageID, assertCurrent: () => true as const } }
    const adapter = nativeRecurrenceAdapter(input)
    const snapshot = () => ({ ...signer, signerDigest: authoritySignerDigest(signer.publicKey) })
    const starts = () => readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.event === "start").length
    await adapter.readSigners()
    writeFileSync(trace, "")
    const at = performance.now()
    for (let i = 0; i < 10; i++) { await adapter.readSigners(); assert.equal(adapter.assertSignerCurrent(snapshot()), true) }
    t.diagnostic(`10 repeated signer reads/current-root checks: ${(performance.now() - at).toFixed(1)}ms, ${starts()} Git processes`)
    assert.equal(starts(), 0, "repeat authentication must not reacquire unchanged root discovery")
    assert.equal(signerReads, 11, "native signer reads must not be cached")

    signer = { ...initial, provisioningGeneration: "new-generation" }
    await adapter.readSigners()
    assert.throws(() => adapter.assertSignerCurrent({ ...initial, signerDigest: authoritySignerDigest(initial.publicKey) }), /untrusted-signer/)
    assert.equal(adapter.assertSignerCurrent(snapshot()), true)
    assert.equal(starts(), 0, "signer generation is freshly checked, not a physical-root cache key")
    for (const changed of [{ ...root, checkout: root.checkout + ".different" }, { ...root, family: otherFamily }]) {
      signer = { ...initial, roots: [changed] }
      writeFileSync(trace, "")
      await assert.rejects(adapter.readSigners(), /binding-mismatch/)
      assert(starts() > 0, "changed binding at the same directory requires new acquisition")
      assert.throws(() => adapter.assertSignerCurrent(snapshot()), /binding-mismatch/)
    }
    signer = initial
    const entry = path.join(directory, ".git"), saved = entry + ".saved"
    renameSync(entry, saved)
    try {
      writeFileSync(entry, `gitdir: ${otherFamily.replaceAll("\\", "/")}\n`)
      await assert.rejects(adapter.readSigners(), /family-identity-unavailable|binding-mismatch/)
      assert.throws(() => adapter.assertSignerCurrent(snapshot()), /family-identity-unavailable|binding-mismatch/)
    } finally { unlinkSync(entry); renameSync(saved, entry) }
    assert.equal(adapter.assertSignerCurrent(snapshot()), true)
    const config = path.join(family, "config"), original = readFileSync(config), redirected = path.join(temporary, "redirected")
    mkdirSync(redirected)
    try {
      git(directory, "config", "core.worktree", redirected)
      await assert.rejects(adapter.readSigners(), /family-identity-unavailable|binding-mismatch/)
      assert.throws(() => adapter.assertSignerCurrent(snapshot()), /family-identity-unavailable|binding-mismatch/)
    } finally { writeFileSync(config, original) }
    try {
      process.env.GIT_COMMON_DIR = otherFamily
      await assert.rejects(adapter.readSigners(), /family-identity-unavailable|binding-mismatch/)
      assert.throws(() => adapter.assertSignerCurrent(snapshot()), /family-identity-unavailable|binding-mismatch/)
    } finally { delete process.env.GIT_COMMON_DIR }
    assert.equal(adapter.assertSignerCurrent(snapshot()), true)
    writeFileSync(trace, "")
    const replacement = nativeRecurrenceAdapter({ ...input, provider: { ...provider } })
    await replacement.readSigners()
    assert(starts() > 0, "a different adapter/provider lifetime must acquire its own discovery contract")
    providerLive = false
    await assert.rejects(adapter.readSigners(), /provider-retired/)
    assert.throws(() => adapter.assertSignerCurrent(snapshot()), /provider-retired/)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
    await rm(temporary, { recursive: true, force: true })
  }
})
