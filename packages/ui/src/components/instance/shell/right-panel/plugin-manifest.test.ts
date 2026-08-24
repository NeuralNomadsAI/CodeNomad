import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createCoreRightPanelManifest, createCoreStatusSectionManifest } from "./core-plugin"
import { loadRightPanelPluginManifests, type RightPanelHostContext, type RightPanelManifest } from "./plugin-manifest"

const host: RightPanelHostContext = {
  instanceId: "abc",
  t: (key) => key,
  activeSessionId: () => "session-1",
  isTabActive: () => false,
  openTab: () => {},
}

const manifest = (id: string, events: string[]): RightPanelManifest => ({
  id,
  displayNameKey: id,
  origin: "first-party",
  create: (context) => {
    events.push(`${id}:create:${context.instanceId}:${context.activeSessionId()}`)
    return {
      id,
      displayNameKey: id,
      origin: "first-party",
      tabs: [{ id: `${id}-tab`, labelKey: id, order: 10, render: () => undefined as any }],
    }
  },
})

describe("right panel plugin manifests", () => {
  it("creates modules with host context", () => {
    const events: string[] = []
    const runtime = loadRightPanelPluginManifests([manifest("first", events), manifest("second", events)], host)

    assert.deepEqual(runtime.modules.map((entry) => entry.id), ["first", "second"])
    assert.deepEqual(events, ["first:create:abc:session-1", "second:create:abc:session-1"])
  })

  it("skips duplicate ids without blocking other plugins", () => {
    const events: string[] = []
    const runtime = loadRightPanelPluginManifests([manifest("plugin", events), manifest("plugin", events), manifest("other", events)], host)

    assert.deepEqual(runtime.modules.map((entry) => entry.id), ["plugin", "other"])
    assert.equal(runtime.errors.length, 1)
    assert.equal(runtime.errors[0]?.pluginId, "plugin")
  })

  it("skips plugins that fail during load", () => {
    const runtime = loadRightPanelPluginManifests(
      [
        { id: "bad", displayNameKey: "bad", origin: "first-party", create: () => { throw new Error("boom") } },
        manifest("good", []),
      ],
      host,
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

    const rightPanelModule = rightPanel.create(host)

    assert.deepEqual(rightPanelModule.tabs?.map((entry) => entry.id), ["git-changes", "files", "status"])
    assert.equal(rightPanelModule.tabs?.find((entry) => entry.id === "status")?.alwaysVisible, true)
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
