import assert from "node:assert/strict"
import test from "node:test"

import { buildListedProviders, buildProviderVisibilityModels } from "./provider-options.ts"

test("keeps unmatched custom and model-only providers in the cold-start catalog", () => {
  const providers = [
    { id: "known-models", integrationID: "known", name: "Known Models", package: "known" },
    { id: "custom", name: "Custom Provider", package: "custom" },
  ] as any[]
  const models = [
    { id: "known-model", providerID: "known-models" },
    { id: "custom-model", providerID: "custom" },
    { id: "cold-model", providerID: "model-only" },
  ] as any[]
  const integrations = [{ id: "known", name: "Known", methods: [{ type: "key", label: "API key" }], connections: [] }] as any[]

  assert.deepEqual(buildListedProviders(providers, models, integrations), [
    { id: "known", name: "Known", modelCount: 1, source: "config", credentialIds: [], canConnect: true },
    { id: "custom", name: "Custom Provider", modelCount: 1, source: "custom", credentialIds: [], canConnect: false },
    { id: "model-only", name: "model-only", modelCount: 1, source: "unknown", credentialIds: [], canConnect: false },
  ])
})

test("only integrations with native auth methods offer Connect", () => {
  const integrations = [
    { id: "env-only", name: "Environment", methods: [{ type: "env", names: ["TOKEN"] }], connections: [] },
    { id: "oauth", name: "OAuth", methods: [{ id: "oauth", type: "oauth", label: "OAuth" }], connections: [] },
  ] as any[]

  const listed = buildListedProviders([], [], integrations)
  assert.equal(listed.find((provider) => provider.id === "env-only")?.canConnect, false)
  assert.equal(listed.find((provider) => provider.id === "oauth")?.canConnect, true)
})

test("keeps native provider ids when one integration groups multiple providers", () => {
  const providers = [
    { id: "openai-api", integrationID: "openai" },
    { id: "openai-subscription", integrationID: "openai" },
  ] as any[]
  const models = [
    { id: "gpt-api", name: "GPT API", providerID: "openai-api" },
    { id: "gpt-subscription", name: "GPT Subscription", providerID: "openai-subscription" },
  ] as any[]

  assert.deepEqual(buildProviderVisibilityModels("openai", providers, models), [
    { id: "gpt-api", name: "GPT API", providerId: "openai-api" },
    { id: "gpt-subscription", name: "GPT Subscription", providerId: "openai-subscription" },
  ])
})
