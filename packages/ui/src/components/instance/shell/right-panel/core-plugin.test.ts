import assert from "node:assert/strict"
import { it } from "node:test"
import { createCoreRightPanelModule, createCoreStatusSectionManifest } from "./core-plugin"

it("defines built-in tabs and status sections without a plugin loading layer", () => {
  const render = () => undefined as any
  const module = createCoreRightPanelModule({ renderFilesTab: render, renderStatusTab: render })
  const sections = createCoreStatusSectionManifest({ renderTokens: render, renderYoloModeSection: render,
    renderProviderUsage: render, renderBackgroundProcesses: render, renderMcpStatus: render, renderPluginStatus: render })
  assert.deepEqual(module.tabs?.map(entry => entry.id), ["files", "status"])
  assert.equal(module.tabs?.find(entry => entry.id === "status")?.alwaysVisible, true)
  assert.deepEqual(sections.statusSections?.map(entry => entry.id), ["tokens", "yolo-mode", "provider-usage", "background-processes", "mcp", "plugins"])
  assert.equal(module.tabs?.every(entry => entry.render === render), true)
  assert.equal(sections.statusSections?.every(entry => entry.render === render), true)
})
