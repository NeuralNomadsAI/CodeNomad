// Synthetic native config qualification, in a private daemon/home/database only.
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { tsImport } from "tsx/esm/api"

const { readUsageProviderSettings } = await tsImport("../packages/server/src/usage/native-settings.ts", import.meta.url)
await withProductRuntime(process.argv[2], async ({ configDirectory }) => {
  await writeFile(path.join(configDirectory, "synthetic-key.txt"), "synthetic-file-key\n")
  const provider = apiKey => ({ package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: "https://synthetic.example/v1", apiKey }, models: { fixture: {} } })
  await writeFile(path.join(configDirectory, "opencode.jsonc"), JSON.stringify({ providers: {
    "usage-file": provider("{file:./synthetic-key.txt}"),
    "usage-env": provider("{env:OPENCODE_TEST_HOME}"),
    "usage-missing": provider("{env:USAGE_SYNTHETIC_UNSET}"),
    "usage-missing-file": provider("{file:./absent-synthetic-key.txt}"),
  } }))
  return {}
}, async ({ client, connection, root }) => {
  const location = { directory: root }
  await client.location.get({ location })
  await client.integration.list({ location })
  await client.provider.list({ location })
  const observations = []
  for (const [providerID, expected] of [["usage-file", "synthetic-file-key"], ["usage-env", root], ["usage-missing", ""], ["usage-missing-file", ""]]) {
    const info = await client.provider.get({ providerID, location })
    const value = info.data.settings?.apiKey
    assert.equal(value?.trim(), expected)
    const { context } = await readUsageProviderSettings(connection, providerID, info.location.directory, AbortSignal.timeout(15_000))
    assert.equal(context.settingsStatus, "available")
    assert.equal(context.settings?.apiKey, expected || undefined)
    observations.push({ providerID, substituted: true, empty: value === "", contextStatus: context.settingsStatus })
  }
  console.log(JSON.stringify({ version: (await client.server.info()).version, observations }, null, 2))
})
