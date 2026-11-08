import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { decodeClientSnapshot, normalizeRestorableSession, type ClientSnapshotV1 } from "./client-state-codec.ts"
import { decodeClientSnapshotV2, encodeClientSnapshotV2 } from "./client-state-partitions.ts"
import { activeAppTabId, appTabs, selectAppTab, selectRemoteProjectTab } from "./app-tabs.ts"
import { releaseAppSessionRestoreGate } from "./app-session-restore-gate.ts"
import {
  activeRemoteProjectToken,
  closeRemoteProjectTab,
  closeRemoteProjectTabsForServer,
  openRemoteProjectTab,
  patchRemoteProjectTab,
  remoteProjectTabs,
} from "./remote-project-tabs.ts"
import { remoteViewHost } from "../lib/native/remote-view.ts"

const snapshot = (tabs: unknown[]): ClientSnapshotV1 => ({
  version: 1, revision: 1, savedAt: 1, layout: {},
  session: { tabs, activeTabIndex: 0 } as ClientSnapshotV1["session"],
})

describe("remote project tabs", () => {
  it("restores the server, folder and known title, dropping transient entry URLs and invalid titles", () => {
    const normalized = normalizeRestorableSession({
      activeTabIndex: 0,
      tabs: [
        { kind: "remote-project", profileId: "box", folder: "/srv/app", title: "App", entryUrl: "https://t.example/remote-pair#code" },
        { kind: "remote-project", profileId: "box", title: 42 },
        { kind: "remote-project", profileId: "box", title: "x".repeat(4097) },
        { kind: "remote-project", folder: "/no-server" },
      ],
    })
    assert.deepEqual(normalized?.tabs, [
      { kind: "remote-project", profileId: "box", folder: "/srv/app", title: "App" },
      { kind: "remote-project", profileId: "box" },
      { kind: "remote-project", profileId: "box" },
    ])
    assert.deepEqual(decodeClientSnapshot(snapshot([{ kind: "remote-project", profileId: "box" }]))?.session?.tabs,
      [{ kind: "remote-project", profileId: "box" }])
  })

  it("survive the partitioned native snapshot", async () => {
    const source = snapshot([
      { kind: "remote-project", profileId: "box", folder: "/srv/app", title: "App" },
      { kind: "remote-project", profileId: "other" },
    ])
    const encoded = await encodeClientSnapshotV2(source)
    const decoded = await decodeClientSnapshotV2(encoded.root, 1, async (key) => encoded.partitions[key] ?? null)
    assert.deepEqual(decoded?.session?.tabs, source.session?.tabs)
  })

  it("join the tab bar as separate occurrences and close with their server", () => {
    releaseAppSessionRestoreGate()
    const first = openRemoteProjectTab("box", { folder: "/srv/app", title: "App" })
    assert.equal(first.title, "App")
    assert.notEqual(openRemoteProjectTab("box", { folder: "/srv/app" }).token, first.token)
    const picker = openRemoteProjectTab("box")
    const pairing = openRemoteProjectTab("box", { entryUrl: "https://t.example/remote-pair#code" })
    assert.notEqual(picker.token, pairing.token)
    selectRemoteProjectTab(first.token)
    assert.equal(activeAppTabId(), `remote-project:${first.token}`)
    assert.equal(activeRemoteProjectToken(), first.token)
    assert.equal(appTabs().filter((tab) => tab.kind === "remote-project").length, 4)

    patchRemoteProjectTab(pairing.token, { entryUrl: undefined, folder: "/srv/other", title: "Other" })
    assert.deepEqual(remoteProjectTabs().find((tab) => tab.token === pairing.token), {
      token: pairing.token, profileId: "box", folder: "/srv/other", title: "Other",
    })

    closeRemoteProjectTab(first.token)
    assert.equal(activeRemoteProjectToken(), null)
    closeRemoteProjectTabsForServer("box")
    assert.equal(remoteProjectTabs().length, 0)
    selectAppTab(null)
  })

  it("exist only in local desktop windows that host native views", () => {
    const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"
    assert.equal(remoteViewHost({ host: "electron", windowContext: "local" }, mac), "electron")
    assert.equal(remoteViewHost({ host: "tauri", windowContext: "local" }, windows), "tauri")
    assert.equal(remoteViewHost({ host: "tauri", windowContext: "local" }, mac), undefined)
    // A web client, a Remote Control device, a remote window or Preferences never opens one.
    assert.equal(remoteViewHost({ host: "web", windowContext: "remote" }, windows), undefined)
    assert.equal(remoteViewHost({ host: "electron", windowContext: "remote" }, windows), undefined)
    assert.equal(remoteViewHost({ host: "tauri", windowContext: "remote" }, windows), undefined)
    assert.equal(remoteViewHost({ host: "electron", windowContext: "preferences" }, windows), undefined)
  })
})
