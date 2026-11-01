import assert from "node:assert/strict"
import { test } from "node:test"
import { isIntegrationDocsUrl } from "./bundles-docs"
import { bundlesDocsInputSchema, bundlesDocsHostResultSchema, bundlesDocsResultSchema } from "./bundles-contract"
import { pinnedBlenderCatalog } from "../opencode/integrations/catalog-pinned-fixture"

const good = "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender"
const blender = pinnedBlenderCatalog().integrations[0]!
test("the immutable reviewed Blender catalogue README passes the same-ID opening boundary", () => {
  assert.equal(blender.id, "blender")
  assert(isIntegrationDocsUrl(blender.docs, blender.id))
  assert(bundlesDocsHostResultSchema.safeParse({ outcome: "ready", url: blender.docs }).success)
  assert(!isIntegrationDocsUrl(blender.docs, "houdini"))
  for (const value of [
    blender.docs.replace("/blender/", "/houdini/"), blender.docs.replace("/plugin/README.md", "/README.md"),
    blender.docs.replace("/plugin/README.md", "/plugin/readme.md"), blender.docs.replace("/blob/", "/tree/"),
    blender.docs.replace("/main/", "/other/"), blender.docs.replace("/plugin/", "/other/"),
    blender.docs.replace("/opencode-integrations/", "/other-repository/"), blender.docs.replace("github.com", "evil.test"),
    blender.docs.replace("github.com", "github.com:443"), blender.docs.replace("github.com", "github.com:444"),
    blender.docs.replace("github.com", "user:pass@github.com"), blender.docs.replace("https:", "http:"),
    blender.docs.replace("blender/", "%62lender/"), blender.docs.replace("README.md", "%52EADME.md"),
    blender.docs.replace("/plugin/", "/x/../plugin/"), blender.docs.replace("/plugin/", "/x/%2e%2e/plugin/"),
    blender.docs.replace("/plugin/", "//plugin/"), blender.docs.replace("/plugin/", "\\plugin\\"),
    `${blender.docs}/`, `${blender.docs}?`, `${blender.docs}#`, `${blender.docs}?redirect=https://evil.test`,
    ` ${blender.docs}`, `${blender.docs}\n`,
  ]) assert.equal(isIntegrationDocsUrl(value, blender.id), false, value)
})
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
