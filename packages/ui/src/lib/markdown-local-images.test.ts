import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { renderMarkdown } from "./markdown"
import { localImagePath, matchLocalImage, messageImageCandidates } from "./markdown-local-images"

const png = "data:image/png;base64,iVBORw0KGgo="

describe("Markdown images of local files", () => {
  it("recognizes local paths and leaves loadable sources alone", () => {
    assert.equal(localImagePath("C:/Users/me/image.png"), "C:/Users/me/image.png")
    assert.equal(localImagePath("C:\\Users\\me\\image.png"), "C:/Users/me/image.png")
    assert.equal(localImagePath("file:///C:/Users/me/My%20image.png"), "C:/Users/me/My image.png")
    assert.equal(localImagePath("file:///C:/Users/me/a%23b.png"), "C:/Users/me/a#b.png")
    assert.equal(localImagePath("file://localhost/C:/x.png"), "C:/x.png")
    assert.equal(localImagePath("file://server/share/x.png"), "//server/share/x.png")
    assert.equal(localImagePath("\\\\server\\share\\x.png"), "//server/share/x.png")
    assert.equal(localImagePath("file:///tmp/out.png"), "/tmp/out.png")
    assert.equal(localImagePath("/tmp/opencode/images/x.png"), "/tmp/opencode/images/x.png")
    assert.equal(localImagePath("./assets/logo.png"), "./assets/logo.png")
    for (const source of ["//cdn.example.com/a.png", "https://example.com/a.png", "http://localhost/a.png", png, "blob:x", "#a", "javascript:alert(1)", "vbscript:x"])
      assert.equal(localImagePath(source), undefined, source)
  })

  it("matches exact paths (Windows case-insensitively) and unambiguous relative suffixes", () => {
    const candidates = [
      { paths: ["C:\\Users\\Me\\Temp\\images\\sheep.png"], source: "a" },
      { paths: ["/home/me/project/assets/logo.png"], source: "b" },
      { paths: ["/home/me/other/assets/logo.png"], source: "c" },
      { paths: ["/home/me/project/docs/cover.png"], source: "d" },
    ]
    assert.equal(matchLocalImage(candidates, "c:/users/me/temp/images/SHEEP.png"), "a")
    assert.equal(matchLocalImage(candidates, "/home/me/project/assets/logo.png"), "b")
    assert.equal(matchLocalImage(candidates, "/HOME/me/project/assets/logo.png"), undefined, "POSIX paths stay case-sensitive")
    assert.equal(matchLocalImage(candidates, "./docs/cover.png"), "d")
    assert.equal(matchLocalImage(candidates, "assets/logo.png"), undefined, "an ambiguous relative path matches nothing")
    assert.equal(matchLocalImage(candidates, "../docs/cover.png"), undefined)
    assert.equal(matchLocalImage(candidates, "/elsewhere/sheep.png"), undefined)
    // A file read twice is one path: its relative reference resolves to the newest image.
    const reread = [{ paths: ["/project/output.png"], source: "new" }, { paths: ["/project/output.png"], source: "old" }]
    assert.equal(matchLocalImage(reread, "output.png"), "new")
    // A plain path is literal first: a real `%20` name wins over the decoded space name, and decoding is the fallback.
    const encoded = [{ paths: ["C:/images/a b.png"], source: "space" }, { paths: ["C:/images/a%20b.png"], source: "literal" }]
    assert.equal(matchLocalImage(encoded, localImagePath("C:/images/a%20b.png")!), "literal")
    assert.equal(matchLocalImage(encoded.slice(0, 1), localImagePath("C:/images/a%20b.png")!), "space")
    assert.equal(matchLocalImage(encoded.slice(1), localImagePath("C:/images/a%20b.png")!), "literal")
  })

  it("collects completed tool images by file name and the tool's single-image file path, once per message revision", () => {
    const read = (filePath: string, uri: string, name = "") => ({ type: "tool", tool: "read",
      state: { status: "completed", input: { filePath }, content: [{ type: "file", mime: "image/png", uri, name }] } })
    const parts: unknown[] = [read("C:/old.png", png), { type: "text", text: "x" },
      { type: "tool", state: { status: "running", input: { filePath: "C:/running.png" }, content: [] } },
      { type: "tool", state: { status: "completed", input: { filePath: "C:/broken.png" },
        content: [{ type: "file", mime: "image/png", uri: "data:text/html;base64,PHNjcmlwdD4=", name: "x" }] } },
      read("C:/new.png", png, "C:\\new.png")]
    const message = { revision: 1, partIds: parts.map((_, index) => `p${index}`),
      parts: Object.fromEntries(parts.map((data, index) => [`p${index}`, { data }])) }
    const first = messageImageCandidates(message)
    assert.deepEqual(first, [{ paths: ["C:\\new.png", "C:/new.png"], source: png }, { paths: ["C:/old.png"], source: png }])
    // An unchanged revision reuses the scan; a new one rescans the (in-place) parts.
    message.parts.p0 = { data: { type: "text", text: "replaced" } }
    assert.equal(messageImageCandidates(message), first)
    message.revision = 2
    assert.deepEqual(messageImageCandidates(message), [{ paths: ["C:\\new.png", "C:/new.png"], source: png }])
  })

  it("renders a local image as its alt text, never as a broken image", async () => {
    const html = await renderMarkdown("Voici ton mouton\n\n![Un petit mouton](C:/Users/Admin/AppData/Local/Temp/opencode/images/ses_x/image_1.png)", { suppressHighlight: true })
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /<span class="markdown-local-image" data-local-image="C:\/Users\/Admin\/AppData\/Local\/Temp\/opencode\/images\/ses_x\/image_1.png"[^>]*>Un petit mouton<\/span>/)
    const unnamed = await renderMarkdown("![](/tmp/out.png)", { suppressHighlight: true })
    assert.match(unnamed, />out\.png<\/span>/)
    const remote = await renderMarkdown("![remote](https://example.com/a.png)", { suppressHighlight: true })
    assert.match(remote, /<img src="https:\/\/example.com\/a.png" alt="remote">/)
    const schemeRelative = await renderMarkdown("![cdn](//cdn.example.com/a.png)", { suppressHighlight: true })
    assert.match(schemeRelative, /<img src="\/\/cdn.example.com\/a.png" alt="cdn">/)
    const hostile = await renderMarkdown('![x"><script>alert(1)</script>](C:/a"onerror="alert(1).png)', { suppressHighlight: true })
    assert.doesNotMatch(hostile, /<script|onerror="alert/)
  })
})
