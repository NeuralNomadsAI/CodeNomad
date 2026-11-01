import assert from "node:assert/strict"
import { test } from "node:test"
import { bundlesHostsResultSchema, bundlesStateResultSchema } from "./bundles-contract"

test("bundles labels, documents and application versions count Unicode code points like native RPC", () => {
  const offer = { offerID: "offer_fixture", label: "Scene", protocol: "ok" }
  for (const key of ["label", "document", "appVersion"]) {
    const limit = key === "appVersion" ? 64 : 120
    for (const char of ["x", "😀"]) {
      assert(bundlesHostsResultSchema.safeParse({ offers: [{ ...offer, [key]: char.repeat(limit) }] }).success)
      assert(!bundlesHostsResultSchema.safeParse({ offers: [{ ...offer, [key]: char.repeat(limit + 1) }] }).success)
    }
  }
  const item = { id: "fixture", family: "native", configured: true, scopes: ["global"], state: "ok",
    activation: { global: "default", project: "default", effective: "default" },
    status: { version: "0.1.0", host: { state: "ok", appVersion: "😀".repeat(64) } },
    attachment: { state: "attached", label: "😀".repeat(120) } }
  assert(bundlesStateResultSchema.safeParse({ catalog: { state: "fresh" }, integrations: [item] }).success)
})

test("additive plugin facts accept older DTOs and reject private or invented states", () => {
  const item = { id: "fixture", family: "api", configured: true, scopes: [], state: "unknown",
    activation: { global: "default", project: "default", effective: "default" } }
  const valid = (plugin?: unknown) => bundlesStateResultSchema.safeParse({ catalog: { state: "fresh" },
    integrations: [{ ...item, ...(plugin ? { plugin } : {}) }] }).success
  assert(valid())
  for (const runtime of ["active", "failed", "unloaded", "unknown"]) assert(valid({ declared: true, runtime }))
  for (const progress of ["pending", "unconfirmed"]) assert(valid({ declared: true, runtime: "unloaded", progress }))
  for (const plugin of [{ runtime: "active" }, { declared: true, runtime: "installed" },
    { declared: true, runtime: "unloaded", progress: "installing" }, { declared: true, runtime: "active", target: "private" }]) assert(!valid(plugin))
})
