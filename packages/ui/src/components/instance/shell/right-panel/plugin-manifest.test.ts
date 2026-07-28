import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createCoreRightPanelManifest, createCoreStatusSectionManifest } from "./core-plugin"
import { loadRightPanelPluginManifests, type RightPanelPluginManifest } from "./plugin-manifest"

const manifest = (id: string, events: string[]): RightPanelPluginManifest => ({
  id,
  tabs: [{ id: `${id}-tab`, labelKey: id, order: 10, render: () => undefined as any }],
  lifecycle: {
    onLoad: (context) => {
      events.push(`${id}:load:${context.instanceId}`)
      return () => events.push(`${id}:cleanup`)
    },
    onUnload: () => events.push(`${id}:unload`),
  },
})

describe("right panel plugin manifests", () => {
  it("loads modules and unloads lifecycle hooks in reverse order", () => {
    const events: string[] = []
    const runtime = loadRightPanelPluginManifests([manifest("first", events), manifest("second", events)], { instanceId: "abc" })

    assert.deepEqual(runtime.modules.map((entry) => entry.id), ["first", "second"])
    assert.deepEqual(events, ["first:load:abc", "second:load:abc"])
    assert.deepEqual(runtime.unload(), [])
    assert.deepEqual(events, ["first:load:abc", "second:load:abc", "second:cleanup", "second:unload", "first:cleanup", "first:unload"])
  })

  it("skips duplicate ids without blocking other plugins", () => {
    const events: string[] = []
    const runtime = loadRightPanelPluginManifests([manifest("plugin", events), manifest("plugin", events), manifest("other", events)], {
      instanceId: "abc",
    })

    assert.deepEqual(runtime.modules.map((entry) => entry.id), ["plugin", "other"])
    assert.equal(runtime.errors.length, 1)
    assert.equal(runtime.errors[0]?.pluginId, "plugin")
  })

  it("skips plugins that fail during load", () => {
    const runtime = loadRightPanelPluginManifests(
      [
        { id: "bad", lifecycle: { onLoad: () => { throw new Error("boom") } } },
        { id: "good", tabs: [{ id: "good-tab", labelKey: "good", order: 10, render: () => undefined as any }] },
      ],
      { instanceId: "abc" },
    )

    assert.deepEqual(runtime.modules.map((entry) => entry.id), ["good"])
    assert.equal(runtime.errors.length, 1)
    assert.equal(runtime.errors[0]?.pluginId, "bad")
  })

  it("defines core right panel tabs and status sections as manifests", () => {
    const render = () => undefined as any
    const rightPanel = createCoreRightPanelManifest({
      renderGitChangesTab: render,
      renderFilesTab: render,
      renderStatusTab: render,
    })
    const statusSections = createCoreStatusSectionManifest({
      renderYoloModeSection: render,
      renderProviderUsage: render,
      renderPlanSectionContent: render,
      renderBackgroundProcesses: render,
      renderMcpStatus: render,
      renderLspStatus: render,
      renderPluginStatus: render,
    })

    assert.deepEqual(rightPanel.tabs?.map((entry) => entry.id), ["git-changes", "files", "status"])
    assert.deepEqual(statusSections.statusSections?.map((entry) => entry.id), [
      "yolo-mode",
      "provider-usage",
      "plan",
      "background-processes",
      "mcp",
      "lsp",
      "plugins",
    ])
  })
})
