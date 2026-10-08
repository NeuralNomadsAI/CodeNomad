import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { withProductRuntime } from "./native-product-fixture.mjs"

await withProductRuntime(process.argv[2], async () => {}, async ({ client, root }) => {
  const location = { directory: root }
  await client.location.get({ location })
  let integration
  const deadline = Date.now() + 30_000
  do {
    integration = (await client.integration.list({ location })).data.find(item => item.id === "openai" && item.methods.some(method => method.type === "key"))
    if (!integration) await delay(100)
  } while (!integration && Date.now() < deadline)
  assert(integration, "Fixture needs native OpenAI key registration; no remote validation or generation is requested")
  const list = async () => (await client.integration.list({ location })).data.find(item => item.id === integration.id).connections.filter(item => item.type === "credential")
  await client.integration.connect.key({ integrationID: integration.id, key: "fixture-only-one", label: "First", location })
  await client.integration.connect.key({ integrationID: integration.id, key: "fixture-only-two", label: "Second", location })
  let connections = await list()
  assert.equal(connections.length, 2)
  assert.equal(connections[0].label, "Second", "Native first connection is active")
  const first = connections.find(item => item.label === "First")
  await client.credential.activate({ credentialID: first.id })
  assert.equal((await list())[0].id, first.id)
  await client.credential.update({ credentialID: first.id, label: "Renamed" })
  assert.equal((await list())[0].label, "Renamed")
  await client.credential.remove({ credentialID: first.id })
  connections = await list()
  assert.equal(connections.length, 1)
  assert.equal(connections[0].label, "Second", "Removing one account retains the other")
  assert.equal(JSON.stringify(connections).includes("fixture-only"), false)
  console.log("PASS native multiple accounts, active ordering, rename, single-account removal and secret-free catalog")
})
