import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { hydrateRestorableAttachment, serializeDraftAttachments } from "./client-state-attachments-codec.ts"
import { decodeClientSnapshot, isFutureClientSnapshot, normalizeRestorableSession } from "./client-state-codec.ts"

type UnknownRecord = Record<string, unknown>

const workspace = (overrides: UnknownRecord = {}): UnknownRecord => ({
  kind: "workspace", folder: "/work", drafts: {}, attachments: {}, scrollSnapshots: {}, ...overrides,
})
const session = (...tabs: unknown[]) => normalizeRestorableSession({ activeTabIndex: 0, tabs })
const snapshot = (overrides: UnknownRecord = {}) => ({
  version: 1, revision: 1, savedAt: 1, layout: {}, session: null, ...overrides,
})
const attachment = (source: UnknownRecord, overrides: UnknownRecord = {}) => ({
  id: "item", type: source.type, display: "@item",
  url: "",
  filename: "item",
  mediaType: "text/plain",
  source,
  ...overrides,
})
const file = (path: string, overrides: UnknownRecord = {}) => attachment(
  { type: "file", path, mime: "text/plain" },
  { filename: path.split(/[\\/]/).pop() || path, ...overrides },
)
const firstWorkspace = (value: ReturnType<typeof normalizeRestorableSession>) => {
  const tab = value?.tabs[0]
  assert.ok(tab?.kind === "workspace")
  return tab
}
const normalizeWorkspace = (overrides: UnknownRecord) => firstWorkspace(session(workspace(overrides)))

describe("client state codec", () => {
  it("normalizes v1 workspace state, scroll state, and a sidecar", () => {
    const decoded = decodeClientSnapshot(snapshot({
      revision: 7,
      layout: { drawer: "320" },
      session: {
        activeTabIndex: 8,
        tabs: [workspace({
          type: "instance", kind: undefined, folder: "C:/work/project", occurrence: 1, projectName: "Project",
          drafts: { session1: "unfinished prompt" },
          scrollSnapshots: { session1: { scrollTop: 120, scrollRatio: 0.5, atBottom: false, updatedAt: 1200 } },
          unseenIdleSince: { session1: 1100, malformed: -1 },
          generationRecovery: { session1: "working", session2: "interrupted", malformed: "idle" },
        }), { kind: "sidecar", sidecarId: "docs" }],
      },
    }))

    assert.equal(decoded?.revision, 7)
    assert.equal(decoded?.session?.activeTabIndex, 1)
    const tab = decoded?.session?.tabs[0]
    assert.equal(tab?.kind, "workspace")
    if (tab?.kind !== "workspace") return
    assert.equal(tab.occurrence, 1)
    assert.deepEqual({ ...tab.drafts }, { session1: "unfinished prompt" })
    assert.deepEqual({ ...tab.unseenIdleSince }, { session1: 1100 })
    assert.deepEqual({ ...tab.generationRecovery }, { session1: "working", session2: "interrupted" })
    assert.deepEqual(tab.scrollSnapshots.session1, { scrollTop: 120, scrollRatio: 0.5, atBottom: false, updatedAt: 1200 })
    assert.deepEqual(decoded?.session?.tabs[1], { kind: "sidecar", sidecarId: "docs" })
  })

  it("rejects malformed snapshots/sessions and recognizes future envelopes", () => {
    const cases: [string, unknown, unknown][] = [
      ["future version", snapshot({ version: 2 }), null],
      ["negative revision", snapshot({ revision: -1 }), null],
      ["non-record layout", snapshot({ layout: [] }), null],
    ]
    for (const [label, value, expected] of cases) assert.equal(decodeClientSnapshot(value), expected, label)
    assert.equal(isFutureClientSnapshot({ version: 2 }), true, "future envelope")
    assert.equal(isFutureClientSnapshot({ version: 1 }), false, "current envelope")
    assert.equal(normalizeRestorableSession({ tabs: [{ kind: "workspace" }], activeTabIndex: 0 }), null)
  })

  it("caps records and drops unsafe or malformed entries", () => {
    const drafts = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`session-${index}`, `draft-${index}`]))
    Object.defineProperty(drafts, "__proto__", { value: "unsafe", enumerable: true })
    const tab = normalizeWorkspace({
      drafts,
      scrollSnapshots: {
        valid: { scrollTop: 10, atBottom: true, updatedAt: 100 },
        malformed: { scrollTop: Number.NaN, atBottom: false, updatedAt: 100 },
      },
    })
    assert.equal(Object.keys(tab.drafts).length, 24)
    assert.equal(Object.prototype.hasOwnProperty.call(tab.drafts, "__proto__"), false)
    assert.deepEqual(tab.scrollSnapshots.valid, { scrollTop: 10, atBottom: true, updatedAt: 100 })
    assert.equal(tab.scrollSnapshots.malformed, undefined)
  })

  it("remaps active tabs after filtering, including a filtered active tab", () => {
    const cases = [
      ["surviving active identity", 2, [{ kind: "sidecar" },
        { kind: "sidecar", sidecarId: "first" }, { kind: "sidecar", sidecarId: "active" }], 1],
      ["filtered active fallback", 0, [{ kind: "sidecar" }, { kind: "sidecar", sidecarId: "fallback" }], 0],
    ] as const
    for (const [label, activeTabIndex, tabs, expected] of cases) {
      const normalized = normalizeRestorableSession({ activeTabIndex, tabs })
      assert.equal(normalized?.activeTabIndex, expected, label)
    }
  })

  it("round trips text, file, symbol, and agent attachments", () => {
    const attachments = [
      attachment({ type: "text", value: "alpha\nbeta\ngamma\ndelta" }, { id: "paste", type: "text", display: "pasted #1 (4 lines)" }),
      attachment(
        { type: "file", path: "image.png", mime: "image/png", data: new Uint8Array([1, 2]) },
        {
          id: "image", type: "file", display: "[Image #1]", url: "data:image/png;base64,iVBORw0KGgo=",
          filename: "image.png", mediaType: "image/png",
        },
      ),
      attachment(
        {
          type: "symbol", path: "src/main.ts", name: "run", kind: 12,
          range: { start: { line: 1, char: 2 }, end: { line: 3, char: 4 } },
        },
        { id: "symbol", type: "symbol" },
      ),
      attachment({ type: "agent", name: "reviewer" }, { id: "agent", type: "agent" }),
    ]
    const decoded = decodeClientSnapshot(snapshot({ session: { activeTabIndex: 0, tabs: [workspace({
      drafts: { session1: "Review [pasted #1] and [Image #1]" }, attachments: { session1: attachments },
    })] } }))
    const roundTripped = decodeClientSnapshot(JSON.parse(JSON.stringify(decoded)))
    const tab = roundTripped?.session?.tabs[0]
    assert.equal(tab?.kind, "workspace")
    if (tab?.kind !== "workspace") return
    assert.deepEqual(tab.attachments.session1?.map((item) => item.source.type), ["text", "file", "symbol", "agent"])
    const restored = hydrateRestorableAttachment(tab.attachments.session1![1]!)
    assert.deepEqual(restored?.source.type === "file" ? [...(restored.source.data ?? [])] : null,
      [137, 80, 78, 71, 13, 10, 26, 10])
    assert.ok(Buffer.byteLength(JSON.stringify(roundTripped), "utf8") < 1024 * 1024)
  })

  it("drops unsupported attachments but retains oversized path-backed files and exact mentions", () => {
    const mention = "@./reports/exact report.txt"
    const oversizedData = new Uint8Array(64 * 1024 + 1)
    oversizedData.subarray = () => { throw new Error("oversized data must not be Base64 encoded") }
    const large = file("./reports/exact report.txt", {
      id: "large", display: "@exact report.txt", url: "file:///work/reports/exact%20report.txt",
      filename: "exact report.txt", source: { type: "file", path: "./reports/exact report.txt", mime: "text/plain", data: oversizedData },
    })
    const unsupported = attachment({ type: "archive" }, { id: "unsupported", type: "archive", display: "@unsupported" })
    const tab = normalizeWorkspace({
      drafts: { session1: `Review ${mention}; remove @unsupported` }, attachments: { session1: [large, unsupported] },
    })
    assert.equal(tab.attachments.session1?.length, 1)
    assert.deepEqual(tab.attachments.session1?.[0]?.source,
      { type: "file", path: "./reports/exact report.txt", mime: "text/plain" })
    assert.equal(tab.drafts.session1, `Review ${mention}; remove `)
  })

  it("reserves structural and active-session identity before optional strings", () => {
    const drafts = { first: "a".repeat(32 * 1024), second: "b".repeat(32 * 1024), third: "c".repeat(32 * 1024) }
    const normalized = normalizeRestorableSession({ activeTabIndex: 1, tabs: [
      workspace({ folder: "/large", drafts }), { kind: "sidecar", sidecarId: "later-sidecar" },
    ] })
    assert.deepEqual(normalized?.tabs[1], { kind: "sidecar", sidecarId: "later-sidecar" })
    assert.equal(normalized?.activeTabIndex, 1)

    const tab = normalizeWorkspace({
      activeParentSessionId: "parent-session", activeSessionId: "child-session", drafts,
    })
    assert.equal(tab.activeParentSessionId, "parent-session")
    assert.equal(tab.activeSessionId, "child-session")

    const decoded = decodeClientSnapshot(snapshot({
      layout: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`panel-${index}`, "x".repeat(4096)])),
      session: { activeTabIndex: 0, tabs: [{ kind: "sidecar", sidecarId: "structural-tab" }] },
    }))
    assert.deepEqual(decoded?.session?.tabs, [{ kind: "sidecar", sidecarId: "structural-tab" }])
  })

  it("normalizes a valid unversioned legacy snapshot to version 1", () => {
    const legacy: UnknownRecord = snapshot({ session: { activeTabIndex: 0, tabs: [workspace()] } })
    delete legacy.version
    const decoded = decodeClientSnapshot(legacy)
    assert.equal(decoded?.version, 1)
    assert.equal(decoded?.session?.tabs[0]?.kind, "workspace")
    assert.equal(decodeClientSnapshot({ ...legacy, version: 2 }), null)
  })

  for (const [label, activeSessionId] of [
    ["active session", "active-session"],
    ["active no-session prompt", "__no_session_draft__"],
  ] as const) {
    it(`retains the ${label} draft beyond the per-tab entry budget`, () => {
      const drafts = Object.fromEntries([
        ...Array.from({ length: 24 }, (_, index) => [`older-${index}`, `draft-${index}`]),
        [activeSessionId, "unsent active draft"],
      ])
      const tab = normalizeRestorableSession({ activeTabIndex: 0, tabs: [workspace({
        activeSessionId: activeSessionId === "__no_session_draft__" ? undefined : activeSessionId,
        drafts,
      })] })?.tabs[0]

      assert.equal(tab?.kind === "workspace" ? tab.drafts[activeSessionId] : undefined, "unsent active draft")
      assert.equal(tab?.kind === "workspace" ? Object.keys(tab.drafts).length : 0, 24)
    })
  }

  it("retains the active tab draft before earlier tabs consume the string budget", () => {
    const normalized = normalizeRestorableSession({ activeTabIndex: 1, tabs: [
      workspace({ drafts: {
        first: "a".repeat(32 * 1024), second: "b".repeat(32 * 1024), third: "c".repeat(32 * 1024),
      } }),
      workspace({ folder: "/active", activeSessionId: "active", drafts: { active: "keep me" } }),
    ] })
    const active = normalized?.tabs[1]

    assert.equal(active?.kind === "workspace" ? active.drafts.active : undefined, "keep me")
    assert.equal(normalized?.activeTabIndex, 1)
  })

  it("retains the active tab draft before inactive tab identities consume the string budget", () => {
    const normalized = normalizeRestorableSession({ activeTabIndex: 24, tabs: [
      ...Array.from({ length: 24 }, (_, index) => workspace({ folder: `${index}${"x".repeat(4095)}` })),
      workspace({ folder: "/active", activeSessionId: "active", drafts: { active: "keep me" } }),
    ] })
    const active = normalized?.tabs.find((tab) => tab.kind === "workspace" && tab.folder === "/active")

    assert.equal(active?.kind === "workspace" ? active.drafts.active : undefined, "keep me")
    assert.equal(normalized?.tabs[normalized.activeTabIndex], active)
  })

  it("retains active-session attachments beyond the per-tab session budget", () => {
    const activeAttachment = file("active.png", { id: "active-image", display: "[Image #1]", mediaType: "image/png" })
    const attachments = Object.fromEntries([
      ...Array.from({ length: 24 }, (_, index) => [`older-${index}`, [file(`older-${index}.txt`)]]),
      ["active", [activeAttachment]],
    ])
    const tab = normalizeRestorableSession({ activeTabIndex: 0, tabs: [workspace({
      activeSessionId: "active",
      drafts: { active: "Review [Image #1]" },
      attachments,
    })] })?.tabs[0]

    assert.equal(tab?.kind === "workspace" ? tab.attachments.active?.[0]?.id : undefined, "active-image")
    assert.equal(tab?.kind === "workspace" ? tab.drafts.active : undefined, "Review [Image #1]")
  })

  it("prioritizes active attachments during capture serialization", () => {
    const activeAttachment = file("active.png", { id: "active-image", display: "[Image #1]", mediaType: "image/png" })
    const attachments = Object.fromEntries([
      ...Array.from({ length: 24 }, (_, index) => [`older-${index}`, [file(`older-${index}.txt`)]]),
      ["active", [activeAttachment]],
    ]) as never
    const captured = serializeDraftAttachments({ active: "Review [Image #1]" }, attachments, ["active"])

    assert.equal(captured.attachments.active?.[0]?.id, "active-image")
    assert.equal(captured.drafts.active, "Review [Image #1]")
  })

  it("does not let malformed tabs consume the identity budget", () => {
    const normalized = normalizeRestorableSession({ activeTabIndex: 24, tabs: [
      ...Array.from({ length: 24 }, () => workspace({ folder: "x".repeat(4096), drafts: [] })),
      { kind: "sidecar", sidecarId: "valid-late-tab" },
    ] })
    assert.deepEqual(normalized, { tabs: [{ kind: "sidecar", sidecarId: "valid-late-tab" }], activeTabIndex: 0 })
  })

  it("removes every picker mention for attachments beyond the per-session limit", () => {
    const cases = [
      ["relative file", "./dir/f8", "f8", "@f8",
        ["@./dir/f8", "@f8"], ["@./dir/f80", "@f80"], "text/plain"],
      ["absolute file", "/var/work/f8.ts", "f8.ts", "@f8.ts",
        ["@/var/work/f8.ts", "@f8.ts"], ["@/var/work/f8.ts.bak", "@f8.tsx"], "text/plain"],
      ["Windows regex characters", "C:\\work\\[draft](8).ts", "[draft](8).ts", "@[draft](8).ts",
        ["@C:\\work\\[draft](8).ts", "@[draft](8).ts"],
        ["@C:\\work\\[draft](8).tsx", "@[draft](8).tsx"], "text/plain"],
      ["raw spaced path", "./dir/my file.ts", "my file.ts", "@my file.ts",
        ["@./dir/my file.ts", "@my file.ts"], ["@./dir/my file.tsx", "@my file.tsx"], "text/plain"],
      ["relative directory", "./dir/nested", "nested/", "@nested/",
        ["@dir/nested/", "@nested/"], ["@dir/nested/other", "@nested/other"], "inode/directory"],
    ] as const
    for (const [label, path, filename, display, tokens, collisions, mime] of cases) {
      const keep = Array.from({ length: 8 }, (_, index) => file(`./keep/${index}`, { id: `keep-${index}` }))
      const tab = normalizeWorkspace({
        drafts: { session: `remove ${tokens.join(" then ")} keep ${collisions.join(" and ")} and @other` },
        attachments: { session: [...keep, file(path, { id: "drop", filename, display,
          mediaType: mime, source: { type: "file", path, mime } })] },
      })
      assert.equal(tab.attachments.session?.length, 8, label)
      assert.equal(tab.drafts.session, `remove  then  keep ${collisions.join(" and ")} and @other`, label)
    }
  })

  it("removes loose dropped placeholders without touching ordinary bracket text", () => {
    const input = [
      "[Image #9]", "[ Image # 9 ]", "[iMaGe # 9]", "Image #9",
      "[Image #90]", "[Image #9 notes]",
      "[pasted #4]", "[ pasted # 4 ]", "[PaStEd # 4]", "pasted #4",
      "[pasted #40]", "[pasted notes]", "[ordinary bracket text]",
    ].join("|")
    const dropped = [
      file("large.png", { id: "image", display: "[Image #9]", mediaType: "image/png",
        source: { type: "file", path: "large.png", mime: "image/png", data: new Uint8Array(65 * 1024) } }),
      attachment({ type: "text", value: "x".repeat(24 * 1024 + 1) }, { id: "paste", type: "text", display: "pasted #4 (4 lines)" }),
      attachment({ type: "archive" }, { id: "ordinary", type: "archive", display: "[ordinary bracket text]" }),
    ]
    const tab = normalizeWorkspace({ drafts: { session1: input }, attachments: { session1: dropped } })
    assert.deepEqual({ ...tab.attachments }, {})
    assert.equal(tab.drafts.session1,
      "|||Image #9|[Image #90]|[Image #9 notes]||||pasted #4|[pasted #40]|[pasted notes]|[ordinary bracket text]")
  })

  it("keeps a maximal normalized attachment snapshot below the native 1 MiB limit", () => {
    const normalized = session(...Array.from({ length: 32 }, (_, index) => workspace({
      folder: `/work/${index}`, drafts: { session: `[Image #${index + 1}]` },
      attachments: { session: [file(`file-${index}.bin`, { id: `file-${index}`, display: `[Image #${index + 1}]`,
        mediaType: "application/octet-stream", source: { type: "file", path: `file-${index}.bin`,
          mime: "application/octet-stream", data: new Uint8Array(64 * 1024) } })] },
    })))
    assert.ok(normalized)
    assert.ok(Buffer.byteLength(JSON.stringify(normalized), "utf8") < 1024 * 1024)
  })
})
