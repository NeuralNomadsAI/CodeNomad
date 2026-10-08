import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"
import { authorityDigest, authoritySignerDigest, MISSION_AUTHORITY_POLICY } from "./authority-protocol"
import { authenticateRecurrenceStanding, deriveRecurrenceChild, recurrenceEffectID, recurrenceHumanRequestID,
  recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY, type RecurrenceChildRecord, type RecurrenceEffect } from "./recurrence-authority-contract"
import { NativeMissionRecurrenceStore } from "./recurrence-store"
import { recurrenceSourceContextLimit } from "./recurrence-read-budget"
import { recurrenceInput, recurrenceReadEvidence, assertRecurrenceStartupReceipts } from "./recurrence-input"
import type { MissionJsonValue } from "./model"

test("current admission qualification requires complete frozen sources and the exact message invocation/receipt identities", async () => {
  // In-memory signature/input contract only: no native graph, files, provider or RPC.
  const values = new Map<string, MissionJsonValue>()
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: MissionJsonValue) => { values.set(key, value) },
    scan: async () => ({ entries: [] }) }
  const directory = "/project", selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
  const config = { template: "custom" as const, consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "native",
    profiles: { coordinator: selection, roles: { specialist: selection } }, taskMode: "native" as const,
    roots: [{ mode: "directory-only" as const, directory }], watchedConversationIDs: ["ses_watched"],
    budgets: { effects: 4, nativeCalls: 0, inboxMessages: 1, publications: 0 }, publication: { policy: "disabled" as const, conversationIDs: [] } }
  const source = new NativeMissionRecurrenceStore(storage, "project", directory)
  let doc = await source.create("schedule", config, 1, () => true)
  doc = await source.reserve(doc.id, 0, { kind: "manual", requestID: "manual", expectedRevision: 0, at: 2 }, 2, () => true)
  const keys = generateKeyPairSync("ed25519"), digest = authoritySignerDigest(keys.publicKey)
  const scope = { namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9", daemonStorageID: "storage", projectID: "project", projectCanonical: directory,
    scheduleID: doc.id, profileID: "profile", executionHost: "native" }
  const body = { ...scope, version: 1 as const, policy: RECURRENCE_AUTHORITY_POLICY, action: "authorize" as const, epoch: 1,
    expectedRevision: null, requestID: recurrenceHumanRequestID(doc.id, 1, "authorize"), scheduleRevision: 0,
    authorityID: `rec_${digest.slice(0, 40)}`, keyID: `key_${digest.slice(0, 40)}`, provisioningGeneration: digest, signerDigest: digest,
    roots: config.roots, config, configDigest: authorityDigest(config), budgets: config.budgets,
    profileSource: { profileID: "profile", executionHost: "native", configYamlPath: "/not-read" } }
  const parent = { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
  authenticateRecurrenceStanding(parent, [{ ...scope, roots: config.roots, authorityID: body.authorityID, keyID: body.keyID,
    provisioningGeneration: digest, publicKey: keys.publicKey, qualification: "qualified", policy: MISSION_AUTHORITY_POLICY }])
  const grant = deriveRecurrenceChild(parent, doc, 1), child: RecurrenceChildRecord = { parent, grant, effects: [] }
  const record = (effect: RecurrenceEffect, evidenceID: string) => {
    const operationID = recurrenceEffectID(grant, effect)
    return { operationID, effect, receipt: { operationID, outcome: "applied" as const, evidenceID } }
  }
  const read: RecurrenceEffect = { kind: "inbox-read", conversationID: "ses_watched", messageIDs: [],
    read: { directory, afterMessageID: null, limit: 1, contextLimit: recurrenceSourceContextLimit(config, []) } }
  const messages = [{ id: "msg_watched", type: "user", text: "Watched source context", nativeDigest: authorityDigest("source") }]
  child.effects.push({ ...record(read, recurrenceReadEvidence(read, messages)), receipt: {
    ...record(read, recurrenceReadEvidence(read, messages)).receipt, sourceMessages: messages } })
  child.effects.push(record({ kind: "create" }, grant.coordinatorSessionID), record({ kind: "start" }, grant.coordinatorSessionID))
  const input = recurrenceInput(child)
  child.effects.push(record({ kind: "coordinator-message", messageID: grant.messageID, contentDigest: authorityDigest(input.text) }, grant.messageID))
  assert.deepEqual(assertRecurrenceStartupReceipts(child), input)
  assert.notEqual(authorityDigest(input.text), authorityDigest(config.consigne), "the invocation includes the actual playbook and frozen sources")
  for (const mutate of [
    (value: RecurrenceChildRecord) => { value.effects.shift() },
    (value: RecurrenceChildRecord) => { value.effects[0].receipt = null },
    (value: RecurrenceChildRecord) => { value.effects[0].receipt!.evidenceID = "rread_wrong" },
    (value: RecurrenceChildRecord) => { value.effects[1].receipt!.operationID = "rce_wrong" },
    (value: RecurrenceChildRecord) => { value.effects[2].receipt!.outcome = "rejected-before-effect" },
    (value: RecurrenceChildRecord) => { value.effects[3] = record({ kind: "coordinator-message", messageID: grant.messageID,
      contentDigest: authorityDigest("arbitrary wrong invocation") }, grant.messageID) },
  ]) { const changed = structuredClone(child); mutate(changed); assert.throws(() => assertRecurrenceStartupReceipts(changed)) }
})
