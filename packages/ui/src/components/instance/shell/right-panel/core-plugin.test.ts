import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { it } from "node:test"

it("defines built-in tabs and status sections without a plugin loading layer", async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "lucide-solid") return { url: "data:text/javascript,export const Info = () => null", shortCircuit: true }
    return next(specifier, context)
  } })
  try {
    const { createCoreRightPanelModule, createCoreStatusSectionManifest } = await import("./core-plugin")
    const render = () => undefined as any
    const summary = () => undefined as any
    const module = createCoreRightPanelModule({ renderFilesTab: render, renderStatusTab: render })
    const sections = createCoreStatusSectionManifest({ renderTokens: render, renderTokensSummary: summary, renderYoloModeSection: render,
      renderProviderUsage: render, renderBackgroundProcesses: render, renderMcpStatus: render, renderPluginStatus: render })
    assert.deepEqual(module.tabs?.map(entry => entry.id), ["files", "status"])
    assert.equal(module.tabs?.find(entry => entry.id === "status")?.alwaysVisible, true)
    assert.deepEqual(sections.statusSections?.map(entry => entry.id), ["tokens", "yolo-mode", "provider-usage", "background-processes", "mcp", "plugins"])
    assert.equal(module.tabs?.every(entry => entry.render === render), true)
    assert.equal(sections.statusSections?.every(entry => entry.render === render), true)
    assert.equal(sections.statusSections?.every(entry => typeof entry.renderInfo === "function"), true)
    assert.equal(sections.statusSections?.find(entry => entry.id === "tokens")?.renderSummary, summary)
    assert.equal(sections.statusSections?.filter(entry => entry.id !== "tokens").every(entry => !entry.renderSummary), true)
  } finally { hooks.deregister() }
})
