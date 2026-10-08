import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { authorityDigest, authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY,
  type ProvisionedAuthoritySigner } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY, type RecurrenceStandingIntent,
  type SignedRecurrenceStandingIntent } from "../../missions/recurrence-authority-contract"
import { physical } from "../../missions/host-authority/private-files"
import { NativeRecurrenceAuthorityStore, type RecurrenceAuthorityDocument } from "../../missions/recurrence-authority-store"
import type { MissionStorage } from "../../missions/journal"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import { applyNativeStandingDecision, nativeRecurrenceAdapter, type NativeStandingSigner } from "./native-recurrence-adapter"

test("native standing human CAS checks signer, protected decision, physical family and native head", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "recurrence-native-"))
  try {
    execFileSync("git", ["init", "-q", temporary])
    const directory = realpathSync(temporary), family = await readFamilyAuthorityIdentity(directory)
    const root = { mode: "git" as const, directory, checkout: physical(directory), family }
    const scope = { namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9", projectID: "project",
      projectCanonical: directory, profileID: "profile", executionHost: "host", scheduleID: "watch", daemonStorageID: "native" }
    const keys = generateKeyPairSync("ed25519")
    const signer: ProvisionedAuthoritySigner = { ...scope, authorityID: "authority", keyID: "key", roots: [root],
      publicKey: keys.publicKey, provisioningGeneration: "generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }
    const config = { consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: scope.profileID,
      executionHost: scope.executionHost, roots: [root], profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
      taskMode: "native", watchedConversationIDs: [], publication: { policy: "disabled", conversationIDs: [] } } as const
    const values = new Map<string, unknown>([[`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, scope.namespace]])
    let live = true, human = true, familyHeld = true, protectedParent: SignedRecurrenceStandingIntent | undefined
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
        assert.deepEqual(request.ledger, protectedHead)
        return true
      },
    }
    const input = { provider, signer: trust, owner: { daemonStorageID: scope.daemonStorageID, namespace: scope.namespace,
      assertCurrent: () => { assert(live); return true as const } },
      familyClaims: new Map([[family, { assertCurrentSync: () => { assert(familyHeld); return true as const },
        assertCurrent: async () => {}, release: async () => {} }]]) }
    const signed = (action: RecurrenceStandingIntent["action"], before: RecurrenceAuthorityDocument | null): SignedRecurrenceStandingIntent => {
      const body: RecurrenceStandingIntent = { ...scope, authorityID: signer.authorityID, keyID: signer.keyID, roots: [root],
        version: 1, policy: RECURRENCE_AUTHORITY_POLICY, action, scheduleRevision: 0, epoch: (before?.parent.body.epoch ?? 0) + 1,
        expectedRevision: before?.revision ?? null, provisioningGeneration: signer.provisioningGeneration,
        signerDigest: authoritySignerDigest(signer.publicKey), config: JSON.parse(canonicalAuthority(config)),
        configDigest: authorityDigest(config), budgets: { effects: 4, nativeCalls: 0, inboxMessages: 0, publications: 0 } }
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
    const paused = await authorize("pause", first)
    assert.equal(paused.parent.body.action, "pause")
    const stopped = await authorize("revoke", paused)
    assert.equal(stopped.parent.body.action, "revoke")
    protectedHead = stopped; protectedParent = signed("authorize", stopped)
    await assert.rejects(applyNativeStandingDecision(input, protectedParent, new AbortController().signal))
    protectedHead = null; await assert.rejects(applyNativeStandingDecision(input, signed("revoke", stopped), new AbortController().signal))
    const adapter = nativeRecurrenceAdapter(input)
    familyHeld = false; assert.throws(() => adapter.assertSignerCurrent({ ...signer, signerDigest: authoritySignerDigest(keys.publicKey) }))
    familyHeld = true
    const other = path.join(directory, "unrelated")
    execFileSync("git", ["init", "-q", other])
    renameSync(path.join(directory, ".git"), path.join(directory, ".git-original"))
    try {
      writeFileSync(path.join(directory, ".git"), `gitdir: ${path.join(other, ".git").replaceAll("\\", "/")}\n`)
      // The original family's claim and checkout path are unchanged. Only a
      // fresh Git common-directory read detects this legitimate worktree move.
      assert.throws(() => adapter.assertSignerCurrent({ ...signer, signerDigest: authoritySignerDigest(keys.publicKey) }))
    } finally {
      unlinkSync(path.join(directory, ".git"))
      renameSync(path.join(directory, ".git-original"), path.join(directory, ".git"))
    }
    human = false; await assert.rejects(applyNativeStandingDecision(input, protectedParent, new AbortController().signal))
    human = true; live = false; await assert.rejects(applyNativeStandingDecision(input, protectedParent, new AbortController().signal))
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
