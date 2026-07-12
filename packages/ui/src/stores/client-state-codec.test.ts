import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { hydrateRestorableAttachment } from "./client-state-attachments-codec.ts"
import {
  decodeClientSnapshot,
  isFutureClientSnapshot,
  normalizeRestorableSession,
  type RestorableTabState,
} from "./client-state-codec.ts"

describe("client state codec", () => {
  it("normalizes a v1 workspace and sidecar session", () => {
    const decoded = decodeClientSnapshot({
      version: 1,
      revision: 7,
      savedAt: 1234,
      layout: { drawer: "320" },
      session: {
        activeTabIndex: 8,
        tabs: [
          {
            type: "instance",
            folder: "C:/work/project",
            occurrence: 1,
            projectName: "Project",
            drafts: { session1: "unfinished prompt" },
            scrollSnapshots: {
              session1: { scrollTop: 120, scrollRatio: 0.5, atBottom: false, updatedAt: 1200 },
            },
            unseenIdleSince: { session1: 1100, malformed: -1 },
            generationRecovery: { session1: "working", session2: "interrupted", malformed: "idle" },
            expandedSessionIds: ["session1", "session1", "session2", 42],
          },
          { kind: "sidecar", sidecarId: "docs" },
        ],
      },
    })

    assert.ok(decoded)
    assert.equal(decoded.revision, 7)
    assert.equal(decoded.session?.activeTabIndex, 1)
    assert.equal(decoded.session?.tabs[0]?.kind, "workspace")
    assert.equal(decoded.session?.tabs[0]?.kind === "workspace" ? decoded.session.tabs[0].occurrence : undefined, 1)
    assert.deepEqual(
      decoded.session?.tabs[0]?.kind === "workspace" ? { ...decoded.session.tabs[0].unseenIdleSince } : undefined,
      { session1: 1100 },
    )
    assert.deepEqual(
      decoded.session?.tabs[0]?.kind === "workspace" ? { ...decoded.session.tabs[0].generationRecovery } : undefined,
      { session1: "working", session2: "interrupted" },
    )
    assert.deepEqual(
      decoded.session?.tabs[0]?.kind === "workspace" ? decoded.session.tabs[0].expandedSessionIds : undefined,
      ["session1", "session2"],
    )
    assert.deepEqual(decoded.session?.tabs[1], { kind: "sidecar", sidecarId: "docs" })
  })

  it("ignores malformed and future snapshots", () => {
    assert.equal(decodeClientSnapshot({ version: 2, revision: 1, savedAt: 1, layout: {}, session: null }), null)
    assert.equal(isFutureClientSnapshot({ version: 2 }), true)
    assert.equal(decodeClientSnapshot({ version: 1, revision: -1, savedAt: 1, layout: {}, session: null }), null)
    assert.equal(decodeClientSnapshot({ version: 1, revision: 1, savedAt: 1, layout: [], session: null }), null)
    assert.equal(normalizeRestorableSession({ tabs: [{ kind: "workspace" }], activeTabIndex: 0 }), null)
  })

  it("caps record counts and drops unsafe or malformed entries", () => {
    const drafts = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`session-${index}`, `draft-${index}`]))
    Object.defineProperty(drafts, "__proto__", { value: "unsafe", enumerable: true })
    const scrollSnapshots = {
      valid: { scrollTop: 10, atBottom: true, updatedAt: 100 },
      malformed: { scrollTop: Number.NaN, atBottom: false, updatedAt: 100 },
    }

    const session = normalizeRestorableSession({
      activeTabIndex: 0,
      tabs: [{ kind: "workspace", folder: "C:/work", drafts, scrollSnapshots }],
    })

    assert.ok(session)
    const workspace = session.tabs[0]
    assert.equal(workspace?.kind, "workspace")
    if (workspace?.kind !== "workspace") return
    assert.equal(Object.keys(workspace.drafts).length, 24)
    assert.equal(Object.prototype.hasOwnProperty.call(workspace.drafts, "__proto__"), false)
    assert.deepEqual(workspace.scrollSnapshots.valid, { scrollTop: 10, atBottom: true, updatedAt: 100 })
    assert.equal(workspace.scrollSnapshots.malformed, undefined)
  })

  it("remaps the active tab by its original identity after malformed tabs are filtered", () => {
    const session = normalizeRestorableSession({
      activeTabIndex: 2,
      tabs: [
        { kind: "sidecar" },
        { kind: "sidecar", sidecarId: "first" },
        { kind: "sidecar", sidecarId: "active" },
        { kind: "sidecar", sidecarId: "last" },
      ],
    })
    assert.equal(session?.activeTabIndex, 1)
    assert.deepEqual(session?.tabs[1], { kind: "sidecar", sidecarId: "active" })

    const filteredActive = normalizeRestorableSession({
      activeTabIndex: 0,
      tabs: [{ kind: "sidecar" }, { kind: "sidecar", sidecarId: "fallback" }],
    })
    assert.equal(filteredActive?.activeTabIndex, 0)
  })

  it("round trips pasted text and bounded file data", () => {
    const decoded = decodeClientSnapshot({
      version: 1,
      revision: 1,
      savedAt: 1,
      layout: {},
      session: {
        activeTabIndex: 0,
        tabs: [{
          kind: "workspace",
          folder: "/work",
          drafts: { session1: "Review [pasted #1] and [Image #1]" },
          attachments: {
            session1: [
              {
                id: "paste-1",
                type: "text",
                display: "pasted #1 (4 lines)",
                url: "data:text/plain;base64,ignored",
                filename: "paste-1.txt",
                mediaType: "text/plain",
                source: { type: "text", value: "alpha\nbeta\ngamma\ndelta" },
              },
              {
                id: "image-1",
                type: "file",
                display: "[Image #1]",
                url: "data:image/png;base64,iVBORw0KGgo=",
                filename: "image-1.png",
                mediaType: "image/png",
                source: { type: "file", path: "image-1.png", mime: "image/png", data: new Uint8Array([1, 2]) },
              },
              {
                id: "symbol-1",
                type: "symbol",
                display: "@run",
                url: "",
                filename: "main.ts",
                mediaType: "text/plain",
                source: {
                  type: "symbol",
                  path: "src/main.ts",
                  name: "run",
                  kind: 12,
                  range: { start: { line: 1, char: 2 }, end: { line: 3, char: 4 } },
                },
              },
              {
                id: "agent-1",
                type: "agent",
                display: "@reviewer",
                url: "",
                filename: "reviewer",
                mediaType: "text/plain",
                source: { type: "agent", name: "reviewer" },
              },
            ],
          },
          scrollSnapshots: {},
        }],
      },
    })

    const roundTripped = decodeClientSnapshot(JSON.parse(JSON.stringify(decoded)))
    const workspace = roundTripped?.session?.tabs[0]
    assert.equal(workspace?.kind, "workspace")
    if (workspace?.kind !== "workspace") return
    assert.equal(workspace.attachments.session1?.length, 4)
    assert.equal(workspace.attachments.session1?.[1]?.source.type, "file")
    assert.equal(workspace.attachments.session1?.[2]?.source.type, "symbol")
    assert.equal(workspace.attachments.session1?.[3]?.source.type, "agent")
    const restored = hydrateRestorableAttachment(workspace.attachments.session1![1]!)
    assert.deepEqual(
      restored?.source.type === "file" ? [...(restored.source.data ?? [])] : null,
      [...new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
    )
    assert.ok(Buffer.byteLength(JSON.stringify(roundTripped), "utf8") < 1024 * 1024)
  })

  it("drops over-cap or unsupported attachments and removes only their exact placeholders", () => {
    const session = normalizeRestorableSession({
      activeTabIndex: 0,
      tabs: [{
        kind: "workspace",
        folder: "/work",
        drafts: { session1: "keep @other, remove [Image #9] and @unsupported" },
        attachments: {
          session1: [
            {
              id: "large",
              type: "file",
              display: "[Image #9]",
              url: "",
              filename: "large.png",
              mediaType: "image/png",
              source: {
                type: "file",
                path: "large.png",
                mime: "image/png",
                data: new Uint8Array(65 * 1024),
              },
            },
            {
              id: "unsupported",
              type: "archive",
              display: "@unsupported",
              url: "",
              filename: "archive.zip",
              mediaType: "application/zip",
              source: { type: "archive" },
            },
          ],
        },
        scrollSnapshots: {},
      }],
    })
    const workspace = session?.tabs[0]
    assert.equal(workspace?.kind, "workspace")
    if (workspace?.kind !== "workspace") return
    assert.equal(Object.keys(workspace.attachments).length, 0)
    assert.equal(workspace.drafts.session1, "keep @other, remove  and ")
  })

  it("removes every picker mention for the ninth file attachment without touching unrelated mentions", () => {
    const cases = [
      {
        name: "relative file",
        path: "./dir/f8",
        filename: "f8",
        display: "@f8",
        tokens: ["@./dir/f8", "@f8"],
        collisions: ["@./dir/f80", "@f80"],
        mime: "text/plain",
      },
      {
        name: "absolute file",
        path: "/var/work/f8.ts",
        filename: "f8.ts",
        display: "@f8.ts",
        tokens: ["@/var/work/f8.ts", "@f8.ts"],
        collisions: ["@/var/work/f8.ts.bak", "@f8.tsx"],
        mime: "text/plain",
      },
      {
        name: "Windows file with regex characters",
        path: "C:\\work\\[draft](8).ts",
        filename: "[draft](8).ts",
        display: "@[draft](8).ts",
        tokens: ["@C:\\work\\[draft](8).ts", "@[draft](8).ts"],
        collisions: ["@C:\\work\\[draft](8).tsx", "@[draft](8).tsx"],
        mime: "text/plain",
      },
      {
        name: "raw spaced file path",
        path: "./dir/my file.ts",
        filename: "my file.ts",
        display: "@my file.ts",
        tokens: ["@./dir/my file.ts", "@my file.ts"],
        collisions: ["@./dir/my file.tsx", "@my file.tsx"],
        mime: "text/plain",
      },
      {
        name: "relative directory",
        path: "./dir/nested",
        filename: "nested/",
        display: "@nested/",
        tokens: ["@dir/nested/", "@nested/"],
        collisions: ["@dir/nested/other", "@nested/other"],
        mime: "inode/directory",
      },
    ]

    const session = normalizeRestorableSession({
      activeTabIndex: 0,
      tabs: cases.map((testCase, caseIndex) => ({
        kind: "workspace",
        folder: `/work/${caseIndex}`,
        drafts: {
          session: `remove ${testCase.tokens.join(" then ")} keep ${testCase.collisions.join(" and ")} and @other`,
        },
        attachments: {
          session: [
            ...Array.from({ length: 8 }, (_, index) => ({
              id: `keep-${caseIndex}-${index}`,
              type: "file",
              display: `@keep-${index}`,
              url: "",
              filename: `keep-${index}`,
              mediaType: "text/plain",
              source: { type: "file", path: `./keep/${caseIndex}/${index}`, mime: "text/plain" },
            })),
            {
              id: `drop-${caseIndex}`,
              type: "file",
              display: testCase.display,
              url: "",
              filename: testCase.filename,
              mediaType: testCase.mime,
              source: { type: "file", path: testCase.path, mime: testCase.mime },
            },
          ],
        },
        scrollSnapshots: {},
      })),
    })

    assert.ok(session)
    for (const [index, testCase] of cases.entries()) {
      const workspace: RestorableTabState | undefined = session.tabs[index]
      assert.equal(workspace?.kind, "workspace", testCase.name)
      if (workspace?.kind !== "workspace") continue
      assert.equal(workspace.attachments.session?.length, 8, testCase.name)
      assert.equal(
        workspace.drafts.session,
        `remove  then  keep ${testCase.collisions.join(" and ")} and @other`,
        testCase.name,
      )
    }
  })

  it("removes loose dropped-attachment placeholders without removing ordinary bracket text", () => {
    const session = normalizeRestorableSession({
      activeTabIndex: 0,
      tabs: [{
        kind: "workspace",
        folder: "/work",
        drafts: {
          session1: [
            "[Image #9]",
            "[ Image # 9 ]",
            "[iMaGe # 9]",
            "Image #9",
            "[Image #90]",
            "[Image #9 notes]",
            "[pasted #4]",
            "[ pasted # 4 ]",
            "[PaStEd # 4]",
            "pasted #4",
            "[pasted #40]",
            "[pasted notes]",
            "[ordinary bracket text]",
          ].join("|"),
        },
        attachments: {
          session1: [
            {
              id: "large-image",
              type: "file",
              display: "[Image #9]",
              url: "",
              filename: "large.png",
              mediaType: "image/png",
              source: {
                type: "file",
                path: "large.png",
                mime: "image/png",
                data: new Uint8Array(65 * 1024),
              },
            },
            {
              id: "large-paste",
              type: "text",
              display: "pasted #4 (4 lines)",
              url: "",
              filename: "paste-4.txt",
              mediaType: "text/plain",
              source: { type: "text", value: "x".repeat(24 * 1024 + 1) },
            },
            {
              id: "ordinary-display",
              type: "archive",
              display: "[ordinary bracket text]",
              url: "",
              filename: "archive.zip",
              mediaType: "application/zip",
              source: { type: "archive" },
            },
          ],
        },
        scrollSnapshots: {},
      }],
    })
    const workspace = session?.tabs[0]
    assert.equal(workspace?.kind, "workspace")
    if (workspace?.kind !== "workspace") return
    assert.equal(Object.keys(workspace.attachments).length, 0)
    assert.equal(
      workspace.drafts.session1,
      "|||Image #9|[Image #90]|[Image #9 notes]||||pasted #4|[pasted #40]|[pasted notes]|[ordinary bracket text]",
    )
  })

  it("keeps the normalized attachment snapshot below the native 1 MiB limit", () => {
    const session = normalizeRestorableSession({
      activeTabIndex: 0,
      tabs: Array.from({ length: 32 }, (_, index) => ({
        kind: "workspace",
        folder: `/work/${index}`,
        drafts: { session: `[Image #${index + 1}]` },
        attachments: {
          session: [{
            id: `file-${index}`,
            type: "file",
            display: `[Image #${index + 1}]`,
            url: "",
            filename: `file-${index}.bin`,
            mediaType: "application/octet-stream",
            source: {
              type: "file",
              path: `file-${index}.bin`,
              mime: "application/octet-stream",
              data: new Uint8Array(64 * 1024),
            },
          }],
        },
        scrollSnapshots: {},
      })),
    })
    assert.ok(session)
    assert.ok(Buffer.byteLength(JSON.stringify(session), "utf8") < 1024 * 1024)
  })
})
