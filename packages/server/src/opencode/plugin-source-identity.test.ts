import assert from "node:assert/strict"
import { test } from "node:test"
import { integrationSourceIdentity } from "./plugin-source-identity"

test("source/context identities stay opaque, stable across writes and scoped to the exact connection and target", () => {
  const connection = {}, location = { directory: "/private-location" }
  const source = { scope: "global" as const, path: "/private-config", target: "private-package@1", entryIndex: 2 }
  const identity = integrationSourceIdentity("instance", location, connection, source)
  assert.match(identity, /^[a-f0-9]{64}$/)
  assert.equal(integrationSourceIdentity("instance", location, connection, { ...source }), identity)
  for (const changed of [{ ...source, entryIndex: 3 }, { ...source, path: "/other" }, { ...source, target: "other" }, { ...source, scope: "project" as const }]) {
    assert.notEqual(integrationSourceIdentity("instance", location, connection, changed), identity)
  }
  assert.notEqual(integrationSourceIdentity("instance", location, {}, source), identity)
  assert.notEqual(integrationSourceIdentity("other", location, connection, source), identity)
  assert.notEqual(integrationSourceIdentity("instance", { directory: "/other" }, connection, source), identity)
  const context = { scope: source.scope, path: source.path }
  assert.notEqual(integrationSourceIdentity("instance", location, connection, context), identity)
  assert.equal(integrationSourceIdentity("instance", location, connection, context), integrationSourceIdentity("instance", location, connection, context))
})
