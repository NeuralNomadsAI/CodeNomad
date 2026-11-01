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
