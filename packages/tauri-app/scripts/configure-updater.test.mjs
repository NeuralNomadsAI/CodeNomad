import assert from "node:assert/strict"
import { test } from "node:test"
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyUpdaterConfig, configPath, configureUpdater, resolveUpdaterConfig } from "./configure-updater.mjs"

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

test("the default path is the real Tauri configuration", () => {
  // The build step runs the script with no arguments, so the resolved default
  // has to be the file the bundler actually reads. An earlier revision pointed
  // one directory too high and every Linux build failed at this step.
  const real = readFileSync(configPath, "utf8")
  const parsed = JSON.parse(real)
  assert.equal(typeof parsed.productName, "string")
  assert.ok(parsed.bundle, "the real configuration still declares its bundle")
  assert.match(configPath.replace(/\\/g, "/"), /packages\/tauri-app\/src-tauri\/tauri\.conf\.json$/)
})

test("a missing configuration names the file it looked for", () => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-updater-missing-"))
  const missing = join(directory, "nested", "tauri.conf.json")
  assert.throws(
    () => configureUpdater({ environment: {}, configPath: missing }),
    (error) => {
      assert.match(error.message, /cannot read the Tauri configuration/)
      const reported = error.message.replace(/\\/g, "/")
      assert.ok(reported.includes(missing.replace(/\\/g, "/")), "the failing path is reported")
      return true
    },
  )
})

test("the real configuration survives a round trip through the unsigned shape", () => {
  // Guards against the script dropping or reshaping anything it does not own
  // when it rewrites the file the Tauri bundler depends on.
  const directory = mkdtempSync(join(tmpdir(), "codenomad-updater-real-"))
  try {
    const copy = join(directory, "tauri.conf.json")
    copyFileSync(configPath, copy)
    const before = readFileSync(configPath, "utf8")
    configureUpdater({ environment: {}, configPath: copy })
    const after = JSON.parse(readFileSync(copy, "utf8"))
    const original = JSON.parse(before)
    assert.deepEqual(Object.keys(after).sort(), Object.keys(original).sort())
    assert.deepEqual(after.bundle, original.bundle, "bundle targets and icons are untouched")
    assert.equal(after.productName, original.productName)
    assert.equal(after.app.windows.length, original.app.windows.length)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
