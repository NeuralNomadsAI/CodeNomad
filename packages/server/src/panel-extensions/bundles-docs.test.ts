import assert from "node:assert/strict"
import { test } from "node:test"
import { isIntegrationDocsUrl } from "./bundles-docs"
import { bundlesDocsInputSchema, bundlesDocsHostResultSchema, bundlesDocsResultSchema } from "./bundles-contract"

const good = "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender"
test("opening accepts only the raw canonical same-ID catalogue documentation URL", () => {
  assert(isIntegrationDocsUrl(good, "blender"))
  assert(!isIntegrationDocsUrl(good, "houdini"))
  for (const value of ["", `${good}/`, `${good}?`, `${good}#`, `${good}?redirect=https://evil.test`, `${good}\n`, ` ${good}`,
    good.replace("https:", "http:"), good.replace("https:", "HTTPS:"), good.replace("github.com", "github.com:443"),
    good.replace("github.com", "github.com:8443"), good.replace("github.com", "GitHub.com"),
    good.replace("github.com", "github.com.evil.test"), good.replace("github.com", "user:pass@github.com"),
    good.replace("github.com", "user@github.com"), good.replace("github.com", "%67ithub.com"),
    good.replace("/tree/main/", "/tree/other/"), good.replace("/tree/main/", "/redirect/"),
    good.replace("/integrations/", "/integrations//"), good.replace("/integrations/", "/integrations/../integrations/"),
    good.replace("/integrations/", "/integrations/%2e%2e/integrations/"), good.replace("/integrations/", "\\integrations\\"),
    good.replace("blender", "%62lender"), good.replace("blender", "blender%2fother"), good.replace("blender", "ｂlender"),
    good.replace("blender", "a".repeat(33)), good.replace("/opencode-integrations/", "/opencode-integrations-evil/")]) {
    assert.equal(isIntegrationDocsUrl(value), false, JSON.stringify(value))
    assert.equal(bundlesDocsHostResultSchema.safeParse({ outcome: "ready", url: value }).success, false)
  }
})
test("docs public/private schemas refuse author authority and private URL results", () => {
  const input = { owner: "a".repeat(64), mountID: "b".repeat(64), integration: "blender" }
  assert(bundlesDocsInputSchema.safeParse(input).success)
  for (const field of ["url", "sessionID", "directory", "digest", "rpc", "path"]) {
    assert(!bundlesDocsInputSchema.safeParse({ ...input, [field]: "PRIVATE_DOCS_SENTINEL" }).success)
  }
  for (const integration of ["../blender", "Blender", "", "a".repeat(33)]) assert(!bundlesDocsInputSchema.safeParse({ ...input, integration }).success)
  for (const outcome of ["requested", "unavailable", "busy", "invalid"]) assert(bundlesDocsResultSchema.safeParse({ outcome }).success)
  assert(!bundlesDocsResultSchema.safeParse({ outcome: "ready", url: good }).success)
  assert(!bundlesDocsResultSchema.safeParse({ outcome: "requested", url: good }).success)
})
