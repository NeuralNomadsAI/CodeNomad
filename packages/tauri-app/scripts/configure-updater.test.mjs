import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyUpdaterConfig, configureUpdater, resolveUpdaterConfig } from "./configure-updater.mjs"

const PUBLIC_KEY = "dW50cnVzdGVkIGNvbW5vbWVkIGFwcGxpY2F0aW9uIHB1YmxpYyBrZXk="
const ENDPOINT = "https://github.com/NeuralNomadsAI/CodeNomad/releases/latest/download/latest.json"

function baseConfig() {
  return {
    productName: "CodeNomad",
    version: "0.20.0",
    plugins: { existing: { keep: true } },
    bundle: { active: true },
  }
}

test("an unsigned build ships without any updater configuration", () => {
  for (const environment of [{}, { TAURI_UPDATER_PUBKEY: "" }, { TAURI_UPDATER_PUBKEY: "   " }]) {
    const updater = resolveUpdaterConfig(environment)
    assert.equal(updater, null)
    const updated = applyUpdaterConfig(baseConfig(), updater)
    assert.equal(updated.plugins.updater, undefined, "no updater entry without a verifiable key")
    assert.deepEqual(updated.plugins.existing, { keep: true }, "unrelated plugin config is preserved")
    assert.equal(updated.version, "0.20.0")
  }
})

test("a signed build enables the updater against the release endpoint by default", () => {
  const updater = resolveUpdaterConfig({ TAURI_UPDATER_PUBKEY: PUBLIC_KEY })
  assert.equal(updater.active, true)
  assert.equal(updater.dialog, false, "the application owns its own update surface")
  assert.equal(updater.pubkey, PUBLIC_KEY)
  assert.deepEqual(updater.endpoints, [ENDPOINT])
})

test("the endpoint can be overridden without touching the key", () => {
  const updater = resolveUpdaterConfig({
    TAURI_UPDATER_PUBKEY: PUBLIC_KEY,
    TAURI_UPDATER_ENDPOINT: "https://example.invalid/latest.json",
  })
  assert.deepEqual(updater.endpoints, ["https://example.invalid/latest.json"])
  assert.equal(updater.pubkey, PUBLIC_KEY)
})

test("configureUpdater writes the effective configuration to disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-updater-"))
  const configPath = join(directory, "tauri.conf.json")

  writeFileSync(configPath, JSON.stringify({ ...baseConfig(), plugins: { updater: { active: true, pubkey: "stale" } } }))
  const disabled = configureUpdater({ environment: {}, configPath })
  assert.equal(disabled, null)
  const withoutKey = JSON.parse(readFileSync(configPath, "utf8"))
  assert.equal(withoutKey.plugins.updater, undefined, "a stale key from a previous build must not survive")

  writeFileSync(configPath, JSON.stringify(baseConfig()))
  const enabled = configureUpdater({ environment: { TAURI_UPDATER_PUBKEY: PUBLIC_KEY }, configPath })
  assert.equal(enabled.pubkey, PUBLIC_KEY)
  const withKey = JSON.parse(readFileSync(configPath, "utf8"))
  assert.equal(withKey.plugins.updater.pubkey, PUBLIC_KEY)
  assert.deepEqual(withKey.plugins.existing, { keep: true })
})
