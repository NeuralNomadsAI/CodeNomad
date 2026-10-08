import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { lstatSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { canonicalScope } from "../host-lifetime/protocol"
import { authorityDigest, authoritySignerDigest } from "./authority-protocol"
import { recurrenceConfigSchema } from "./recurrence-contract"
import { RECURRENCE_AUTHORITY_POLICY, recurrenceHumanRequestID, recurrenceStandingIntentSchema } from "./recurrence-authority-contract"
import { physical } from "./host-authority/private-files"
import { nativeDatabaseStorageID } from "../opencode/missions/native-database-identity"

test("CREATE's selected scope and finite budgets bind Play; managed owner and Play share database identity", async () => {
  const base = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? "C:/Users/Admin/AppData/Local", "Temp", "opencode", "recurrence-compat-"))
  try {
    const file = path.join(base, "native.db")
    await writeFile(file, "offline identity only")
    const stat = lstatSync(file, { bigint: true })
    const managedIdentity = { file: physical(file), dev: String(stat.dev), ino: String(stat.ino), birthtime: String(stat.birthtimeNs) }
    const daemonStorageID = nativeDatabaseStorageID(file)
    assert.equal(daemonStorageID, authorityDigest(managedIdentity))
    assert.notEqual(daemonStorageID, authorityDigest({ ...managedIdentity, birth: managedIdentity.birthtime }),
      "the old birth/birthtime mismatch would strand native due admission")
    const selected = canonicalScope("dev", path.join(base, "custom config.json"), base, base)
    const yaml = path.join(base, "config.yaml")
    const budgets = { effects: 5, nativeCalls: 2, inboxMessages: 4, publications: 0 }
    const config = recurrenceConfigSchema.parse({ template: "custom", consigne: "Review", clock: { time: "07:00", zone: "UTC" },
      profileID: selected.key, executionHost: "local",
      profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
      taskMode: "native", roots: [{ mode: "git", directory: base, family: base, checkout: base }],
      watchedConversationIDs: [], budgets, publication: { policy: "disabled", conversationIDs: [] } })
    const keys = generateKeyPairSync("ed25519"), signerDigest = authoritySignerDigest(keys.publicKey)
    const body = { version: 1, policy: RECURRENCE_AUTHORITY_POLICY, namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9",
      daemonStorageID, projectID: "project", projectCanonical: base, scheduleID: "daily_review",
      profileID: selected.key, executionHost: "local", roots: config.roots,
      authorityID: "authority", keyID: "key", scheduleRevision: 0, epoch: 1, expectedRevision: null,
      requestID: recurrenceHumanRequestID("daily_review", 1, "authorize"), provisioningGeneration: signerDigest, signerDigest,
      action: "authorize", configDigest: authorityDigest(config), config,
      profileSource: { profileID: selected.key, executionHost: "local", configYamlPath: yaml }, budgets }
    assert.deepEqual(recurrenceStandingIntentSchema.parse(body).budgets, budgets)
    assert.equal(recurrenceStandingIntentSchema.safeParse({ ...body, budgets: { ...budgets, effects: 32 } }).success, false)
    assert.equal(recurrenceStandingIntentSchema.safeParse({ ...body, profileID: "forged" }).success, false)
  } finally { await rm(base, { recursive: true, force: true }) }
})
