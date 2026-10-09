import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { InvalidProfileError, legacyChannelKey, parseProfileName, profileDisplayName, profileScope, resolveExplicitProfile } from "./data-profile"

// Shared with Tauri's data_profile.rs tests; scope names are frozen from the pre-profile channel formula.
const vectors = JSON.parse(readFileSync(new URL("./data-profile-vectors.json", import.meta.url), "utf8"))

test("explicit profile names follow the shared grammar", () => {
  for (const { input, key, display } of vectors.profileNames) {
    assert.equal(parseProfileName(input), key, input)
    assert.equal(profileDisplayName(key), display, input)
  }
  for (const input of vectors.invalidProfileNames) {
    assert.throws(() => parseProfileName(input), InvalidProfileError, input)
  }
})

test("the deprecated channel alias keeps its historical normalization", () => {
  for (const { input, key } of vectors.legacyChannels) assert.equal(legacyChannelKey(input), key, input)
  // Electron-only historical divergences remain untouched for existing folders.
  assert.equal(legacyChannelKey("a- b"), "a--b")
  assert.equal(legacyChannelKey("Kelvin"), "kelvin")
})

test("profile scopes reproduce the historical scope names", () => {
  for (const { key, configIdentity, defaultIdentity, scoped, scopeName } of vectors.scopes) {
    const scope = profileScope(key, configIdentity, defaultIdentity)
    assert.equal(scope.scoped, scoped, `${key} ${configIdentity}`)
    assert.equal(scope.scopeName, scopeName, `${key} ${configIdentity}`)
  }
})

test("explicit profile precedence: CODENOMAD_PROFILE, then the alias, then unpackaged dev", () => {
  for (const vector of vectors.explicitProfiles) {
    const environment = { CODENOMAD_PROFILE: vector.profile, CODENOMAD_UPDATE_CHANNEL: vector.channel }
    const resolved = resolveExplicitProfile(environment, vector.packaged)
    assert.deepEqual(resolved ?? null, vector.key === null ? null : { key: vector.key, source: vector.source }, JSON.stringify(vector))
  }
})

test("the installed version is not an input: packaged launches without settings always need the transition", () => {
  assert.equal(resolveExplicitProfile({}, true), undefined)
  assert.equal(resolveExplicitProfile.length, 2)
})
