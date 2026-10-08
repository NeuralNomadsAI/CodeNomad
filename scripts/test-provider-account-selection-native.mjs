import assert from "node:assert/strict"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { ProviderAccountsService } from "../packages/server/src/provider-accounts/service.ts"
import { SettingsService } from "../packages/server/src/settings/service.ts"
import { resolveConfigLocation } from "../packages/server/src/config/location.ts"
import path from "node:path"
import { readFile } from "node:fs/promises"

// Run with node --import tsx and an absolute isolated 2.0.20+ CLI path.
// Native selection/storage are real; tokens and the quota transport are synthetic.
await withProductRuntime(process.argv[2], async () => {}, async ({ client, root, requests }) => {
  const location = { directory: root }
  await client.location.get({ location })
  const first = await client.credential.create({ integrationID: "openai", label: "default", value: {
    type: "oauth", methodID: "chatgpt-browser", access: "fixture-access-one", refresh: "fixture-refresh-one",
    expires: Date.now() + 3600000, metadata: { accountID: "fixture-one", email: "one@example.com" },
  }, activate: true })
  const second = await client.credential.create({ integrationID: "openai", label: "Team alias", value: {
    type: "oauth", methodID: "chatgpt-browser", access: "fixture-access-two", refresh: "fixture-refresh-two",
    expires: Date.now() + 3600000, metadata: { accountID: "fixture-two", email: "two@example.com" },
  }, activate: false })
  const session = await client.session.create({ location, model: { providerID: "openai", id: "gpt-5" } })
  const configLocation = resolveConfigLocation(path.join(root, "codenomad"))
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
  const settings = new SettingsService(configLocation, undefined, logger)
  const quotas = { "fixture-one": 100, "fixture-two": 25 }
  const calls = []
  const service = new ProviderAccountsService(settings, async (_access, accountID) => {
    calls.push(accountID)
    return { windows: { "5h": { usedPercent: quotas[accountID], remainingPercent: 100 - quotas[accountID],
      windowSeconds: 18000, resetAt: Date.now() + 3600000 } } }
  })
  const connection = { client, assertCurrent: () => {} }
  const signal = () => AbortSignal.timeout(15000)
  const selected = async () => (await client.integration.get({ integrationID: "openai", location })).data.connections[0]
  const snapshot = await service.snapshot(connection, root, "openai", signal())
  assert.deepEqual(snapshot.logins, { [first.id]: "one@example.com" })
  assert.equal(snapshot.supported, true)
  await service.beforeSend(connection, session.id, signal(), async directory => directory === root)
  assert.equal((await selected()).id, first.id)
  assert.equal(calls.length, 0)
  service.setEnabled(true)
  await Promise.all([1, 2].map(() => service.beforeSend(connection, session.id, signal(), async directory => directory === root)))
  assert.equal((await selected()).id, second.id)
  assert.equal((await selected()).label, "Team alias")
  quotas["fixture-two"] = 100
  await service.beforeSend(connection, session.id, signal(), async () => true)
  assert.equal((await selected()).id, second.id, "All exhausted retains native selection")
  service.setEnabled(false)
  assert.equal(new ProviderAccountsService(new SettingsService(configLocation, undefined, logger)).enabled(), false,
    "Policy survives a fresh YAML read")
  const persisted = await readFile(configLocation.configYamlPath, "utf8")
  assert.ok(persisted.includes("providerAccounts"))
  assert.equal(persisted.includes("fixture-access"), false)
  const exported = await client.credential.list()
  assert.equal(exported.find(entry => entry.id === first.id).label, "default", "Derived login never renames a credential")
  assert.equal(JSON.stringify(snapshot).includes("fixture-access"), false)
  assert.equal(requests.length, 0, "No model generation or remote quota request")
  console.log("PASS native Codex account selection, concurrent admission, alias/login boundary, exhaustion and opt-in persistence")
})
