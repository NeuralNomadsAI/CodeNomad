import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RightPanelHostContext } from "./plugin-manifest"
import { RIGHT_PANEL_PLUGIN_MANIFESTS } from "./plugins"
import { WORKFLOWS_PLUGIN_MANIFEST } from "./workflows-plugin"

const host: RightPanelHostContext = {
  instanceId: "instance-1",
  t: (key) => key,
  activeSessionId: () => "session-1",
  isTabActive: (id) => id === "workflows",
  openTab: () => {},
}

describe("workflows right panel manifest", () => {
  it("registers the workflows tab with stable metadata", () => {
    const module = WORKFLOWS_PLUGIN_MANIFEST.create(host)

    assert.equal(WORKFLOWS_PLUGIN_MANIFEST.id, "workflows")
    assert.equal(WORKFLOWS_PLUGIN_MANIFEST.displayNameKey, "instanceShell.rightPanel.modules.workflows")
    assert.equal(WORKFLOWS_PLUGIN_MANIFEST.descriptionKey, "instanceShell.rightPanel.modules.workflows.description")
    assert.equal(module.id, "workflows")
    assert.deepEqual(module.tabs?.map(({ id, labelKey, order }) => ({ id, labelKey, order })), [
      { id: "workflows", labelKey: "instanceShell.rightPanel.tabs.workflows", order: 5 },
    ])
    assert.equal(module.statusSections, undefined)
  })

  it("is registered as a first-party plugin without lifecycle hooks", () => {
    assert.deepEqual(RIGHT_PANEL_PLUGIN_MANIFESTS, [WORKFLOWS_PLUGIN_MANIFEST])
    assert.deepEqual(Object.keys(WORKFLOWS_PLUGIN_MANIFEST).sort(), ["create", "descriptionKey", "displayNameKey", "id", "origin"])
  })
})
