import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import type { ViteDevServer } from "vite"
import { startDeviceUploadFixture } from "./fixtures/device-upload-server.mjs"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  ;({ server, url } = await startDeviceUploadFixture())
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup(host = "web", context = "remote", params = "") {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" })
  const prompts: any[] = [], paths: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(({ host, context }) => {
    ;(window as any).__CODENOMAD_RUNTIME_HOST__ = host
    ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = context
  }, { host, context })
  await page.route("**/api/**", route => {
    const request = route.request(), target = new URL(request.url())
    if (target.pathname.endsWith("/prompt")) {
      prompts.push(request.postDataJSON())
      return route.fulfill({ json: { data: {} } })
    }
    if (target.pathname.startsWith("/api/filesystem")) {
      paths.push(request.url())
      return route.fulfill({ json: target.pathname.endsWith("/content")
        ? { contents: Buffer.from("SERVER_CONTENT").toString("base64"), encoding: "base64" }
        : { entries: [{ name: "server.txt", path: "/remote/workspace/server.txt", absolutePath: "/remote/workspace/server.txt", type: "file", size: 14 }],
          metadata: { rootPath: "/remote/workspace", currentPath: "/remote/workspace", displayPath: "/remote/workspace", pathKind: "absolute" } } })
    }
    if (/\/api\/workspaces\/[^/]+\/files(?:\/search)?$/.test(target.pathname)) {
      paths.push(request.url())
      return route.fulfill({ json: [{ name: "server.txt", path: "server.txt", type: "file" }, { name: "docs", path: "docs", type: "directory" }] })
    }
    return route.fulfill({ json: {} })
  })
  await page.goto(`${url}${params}`)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, prompts, paths, errors }
}

async function chooseDevice(page: Page) {
  await page.locator(".prompt-actions-menu-trigger").click()
  assert.equal(await page.getByRole("menuitem", { name: /Browse workspace|Upload files/ }).count(), 0)
  assert.equal(await page.getByRole("menuitem", { name: "Attach file…", exact: true }).count(), 1)
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "Attach file…", exact: true }).click()
  return chooser
}

test("device files use native selection and arrive as ordered bytes in the prompt", async () => {
  const { page, prompts, paths, errors } = await setup()
  try {
    const chooser = await chooseDevice(page)
    assert.equal(chooser.isMultiple(), true)
    await chooser.setFiles([])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    const files = [
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Café depuis mon appareil\nSecond line") },
      { name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFuoAAAAASUVORK5CYII=", "base64") },
      { name: "document.pdf", mimeType: "", buffer: Buffer.from("%PDF-1.4\nfixture") },
    ]
    await (await chooseDevice(page)).setFiles(files)
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 3)
    assert.deepEqual(
      await page.evaluate(() => (window as any).fixture.attachments().map((item: any) => item.filename)),
      files.map(file => file.name),
    )
    await page.getByRole("button", { name: "Send message", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
    assert.equal(prompts.length, 1)
    assert.deepEqual(prompts[0].files, files.map(file => ({
      name: file.name, uri: `data:${file.mimeType || "application/pdf"};base64,${file.buffer.toString("base64")}`,
    })))
    assert.deepEqual(paths, [])
    // Resetting the input permits selecting the same file again.
    await (await chooseDevice(page)).setFiles(files[0])
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("project references use the real @ picker and retain host paths instead of copying bytes", async () => {
  const { page, paths, prompts, errors } = await setup("tauri", "local")
  try {
    await page.locator("textarea:visible").first().fill("@server")
    await page.getByText("server.txt", { exact: true }).last().click()
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    await page.getByRole("button", { name: "Send message", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
    assert.ok(paths.length > 0)
    assert.equal(new URL(paths[0]).searchParams.get("directory"), "/remote/workspace")
    assert.deepEqual(prompts[0].files, [{ name: "server.txt", uri: "file:///remote/workspace/./server.txt" }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("device uploads reject oversized files even when a desktop path is exposed", async () => {
  const { page, paths } = await setup("electron", "remote")
  try {
    await page.evaluate(() => Object.defineProperty(File.prototype, "path", { value: "C:\\private\\local.bin" }))
    await (await chooseDevice(page)).setFiles([
      { name: "large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
      { name: "another.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
    ])
    await page.getByText(/large.bin: exceeds 5 MiB per file/).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    assert.deepEqual(paths, [])
  } finally { await page.close() }
})

test("device upload enforces the aggregate file-count budget before reading excess files", async () => {
  const { page } = await setup()
  try {
    await (await chooseDevice(page)).setFiles(Array.from({ length: 11 }, (_, index) => ({
      name: `file-${index}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(String(index)),
    })))
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 10)
    await page.getByText("file-10.txt: exceeds 10 files or 20 MiB total.", { exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() => (window as any).fixture.attachments().map((item: any) => item.filename)),
      Array.from({ length: 10 }, (_, index) => `file-${index}.txt`),
    )
  } finally { await page.close() }
})

test("pending file reads block sending and do not leak into another session", async () => {
  const { page, prompts } = await setup()
  try {
    await page.evaluate(() => {
      const read = File.prototype.arrayBuffer
      File.prototype.arrayBuffer = function () {
        const file = this
        return new Promise((resolve, reject) => {
          ;(window as any).releaseRead = () => read.call(file).then((data) => {
            ;(window as any).readFinished = true
            resolve(data)
          }, reject)
        })
      }
    })
    await page.locator("textarea:visible").first().fill("Keep this prompt")
    await (await chooseDevice(page)).setFiles({ name: "delayed.txt", mimeType: "text/plain", buffer: Buffer.from("late data") })
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true)
    await page.locator("textarea:visible").first().press("Enter")
    assert.equal(prompts.length, 0)
    await page.evaluate(() => (window as any).fixture.switch("other"))
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "")
    await page.evaluate(() => (window as any).releaseRead())
    await page.waitForFunction(() => (window as any).readFinished)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments("other")), [])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments("source")), [])
  } finally { await page.close() }
})

test("a failed device read reports the failure instead of attaching a local path", async () => {
  const { page } = await setup("electron", "remote")
  try {
    await page.evaluate(() => {
      Object.defineProperty(File.prototype, "path", { value: "C:\\private\\unreadable.txt" })
      File.prototype.arrayBuffer = async function () { throw new Error("unreadable") }
    })
    await (await chooseDevice(page)).setFiles({ name: "unreadable.txt", mimeType: "text/plain", buffer: Buffer.from("data") })
    await page.getByText("unreadable.txt: could not be read.", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    await page.locator("textarea:visible").first().fill("Continue without attachment")
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(), true)
  } finally { await page.close() }
})

async function holdReads(page: Page) {
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer
    ;(window as any).readNames = []
    File.prototype.arrayBuffer = function () {
      ;(window as any).readNames.push(this.name)
      if (!this.name.startsWith("held")) return read.call(this)
      return new Promise(resolve => { (window as any).releaseRead = async () => {
        resolve(await read.call(this))
        ;(window as any).finished = true
      } })
    }
  })
}

async function clipboardOrDrop(page: Page, kind: "paste" | "drop", names: string[], mime = "text/plain") {
  await page.evaluate(({ kind, names, mime }) => {
    const data = new DataTransfer()
    for (const name of names) data.items.add(new File([`bytes:${name}`], name, { type: mime }))
    const textarea = document.querySelector("textarea")!
    textarea.dispatchEvent(kind === "paste"
      ? new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      : new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }))
  }, { kind, names, mime })
}

test("clipboard images preserve MIME, filenames and placeholders and share the serialized drop/picker budget", async () => {
  const { page, prompts } = await setup()
  try {
    await holdReads(page)
    await (await chooseDevice(page)).setFiles({ name: "held-first.txt", mimeType: "text/plain", buffer: Buffer.from("first") })
    await page.waitForFunction(() => Boolean((window as any).releaseRead))
    await clipboardOrDrop(page, "paste", ["photo.jpg", "second.jpg"], "image/jpeg")
    await clipboardOrDrop(page, "drop", Array.from({ length: 9 }, (_, i) => `drop-${i}.txt`))
    assert.deepEqual(await page.evaluate(() => (window as any).readNames), ["held-first.txt"])
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true)
    await page.evaluate(() => (window as any).releaseRead())
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 10)
    const attachments = await page.evaluate(() => (window as any).fixture.attachments())
    assert.deepEqual(attachments.slice(0, 3).map((a: any) => a.filename), ["held-first.txt", "photo.jpg", "second.jpg"])
    assert.match(attachments[1].url, /^data:image\/jpeg;base64,/)
    assert.equal(attachments[1].display, "[Image #1]")
    assert.equal(attachments[2].display, "[Image #2]")
    await page.getByText(/drop-7.txt: exceeds 10 files or 20 MiB total/).waitFor()
    await page.getByRole("button", { name: "Send message", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
    assert.equal(prompts[0].files.length, 10)
  } finally { await page.close() }
})

for (const transition of ["session", "roundtrip", "inactive", "unmount", "worktree"]) {
  test(`pending clipboard read is fenced on ${transition} and does not steal focus`, async () => {
    const { page } = await setup()
    try {
      await holdReads(page)
      await clipboardOrDrop(page, "paste", ["held-photo.jpg"], "image/jpeg")
      await page.waitForFunction(() => Boolean((window as any).releaseRead))
      if (transition === "session" || transition === "roundtrip") {
        await page.evaluate(() => (window as any).fixture.switch("other"))
        if (transition === "roundtrip") await page.evaluate(() => (window as any).fixture.switch("source"))
      }
      if (transition === "inactive") {
        await page.evaluate(() => (window as any).fixture.active(false))
        await page.evaluate(() => (window as any).fixture.active(true))
      }
      if (transition === "unmount") await page.evaluate(() => (window as any).fixture.mounted(false))
      if (transition === "worktree") await page.evaluate(() => (window as any).fixture.move("/remote/worktree"))
      await page.locator("#outside").focus()
      await page.evaluate(() => (window as any).releaseRead())
      await page.waitForFunction(() => (window as any).finished)
      await page.waitForTimeout(50)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments("other")), [])
      assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
    } finally { await page.close() }
  })
}

test("a picker opened before an A-B-A transition cannot attach to the returning draft", async () => {
  const { page } = await setup()
  try {
    const chooser = await chooseDevice(page)
    await page.evaluate(() => (window as any).fixture.switch("other"))
    await page.evaluate(() => (window as any).fixture.switch("source"))
    await page.locator("#outside").focus()
    await chooser.setFiles({ name: "old-picker.txt", mimeType: "text/plain", buffer: Buffer.from("stale") })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
    await (await chooseDevice(page)).setFiles({ name: "current.txt", mimeType: "text/plain", buffer: Buffer.from("current") })
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
  } finally { await page.close() }
})

test("mixed acceptance reports each rejection reason once and keeps the draft editable", async () => {
  const { page } = await setup()
  try {
    await page.evaluate(() => {
      const read = File.prototype.arrayBuffer
      File.prototype.arrayBuffer = function () { return this.name === "bad.txt" ? Promise.reject(new Error("unreadable")) : read.call(this) }
    })
    await (await chooseDevice(page)).setFiles([
      { name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("bad") },
      { name: "large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
      { name: "good.txt", mimeType: "text/plain", buffer: Buffer.from("good") },
    ])
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    assert.equal(await page.getByText(/bad.txt: could not be read.*large.bin: exceeds 5 MiB per file/s).count(), 1)
    assert.equal(await page.locator("textarea:visible").first().isEditable(), true)
    await page.getByRole("button", { name: "Remove attachment", exact: true }).click()
    await (await chooseDevice(page)).setFiles({ name: "good.txt", mimeType: "text/plain", buffer: Buffer.from("good") })
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
  } finally { await page.close() }
})

test("one native attachment action is consistent across web and desktop local/remote/WSL contexts", async () => {
  for (const host of ["web", "electron", "tauri"]) for (const context of ["local", "remote"]) {
    const directory = host === "web" ? "/remote/workspace" : "/mnt/c/projects/wsl"
    const { page, paths, prompts } = await setup(host, context, `?directory=${encodeURIComponent(directory)}`)
    try {
      await (await chooseDevice(page)).setFiles({ name: "device.txt", mimeType: "text/plain", buffer: Buffer.from(host) })
      await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
      await page.locator("textarea:visible").first().fill("@server")
      await page.getByText("server.txt", { exact: true }).last().click()
      await page.waitForFunction(() => (window as any).fixture.attachments().length === 2)
      assert.equal(new URL(paths[0]).searchParams.get("directory"), directory)
      await page.getByRole("button", { name: "Send message", exact: true }).click()
      await page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
      assert.deepEqual(prompts[0].files, [
        { name: "device.txt", uri: `data:text/plain;base64,${Buffer.from(host).toString("base64")}` },
        { name: "server.txt", uri: `file://${directory}/./server.txt` },
      ])
    } finally { await page.close() }
  }
})

test("keyboard selection and cancellation restore focus in French and Hebrew at narrow and wide widths", async () => {
  for (const [locale, label] of [["fr", "Joindre un fichier…"], ["he", "צירוף קובץ…"]]) for (const width of [380, 1100]) {
    const { page, errors } = await setup("web", "remote", `?locale=${locale}`)
    try {
      await page.setViewportSize({ width, height: 800 })
      await page.locator("#root").evaluate((root, width) => { root.style.width = `${width - 16}px` }, width)
      await page.locator(".prompt-actions-menu-trigger").focus()
      await page.keyboard.press("Enter")
      const item = page.getByRole("menuitem", { name: label, exact: true })
      await item.focus()
      if (process.env.CODENOMAD_UPLOAD_CAPTURE_DIR) await page.screenshot({ path: `${process.env.CODENOMAD_UPLOAD_CAPTURE_DIR}/attachments-${locale}-${width}.png` })
      const chooser = page.waitForEvent("filechooser")
      await page.keyboard.press("Enter")
      await (await chooser).setFiles([])
      await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("@ keyboard completion, path-only insertion and directories retain their semantics after a worktree move", async () => {
  const { page, paths } = await setup()
  try {
    const textarea = page.locator("textarea:visible").first()
    await textarea.fill("@server")
    await page.getByText("server.txt", { exact: true }).last().waitFor()
    await textarea.press("Tab")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    assert.match(await textarea.inputValue(), /@server.txt/)
    await textarea.press("Shift+Enter")
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.attachments()[0].source.type), "text")
    await textarea.fill("@docs")
    await page.getByText("docs/", { exact: true }).last().waitFor()
    await textarea.press("ArrowDown") // fixture returns server.txt then docs
    await textarea.press("Tab")
    assert.match(await textarea.inputValue(), /@docs\//)
    await page.evaluate(() => (window as any).fixture.move("/remote/feature"))
    await page.getByText("docs/", { exact: true }).last().click()
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 2)
    const directory = await page.evaluate(() => (window as any).fixture.attachments()[1])
    assert.equal(directory.mediaType, "inode/directory")
    assert.match(directory.url, /^file:\/\/\/remote\/feature\//)
    assert.ok(paths.some(url => new URL(url).searchParams.get("directory") === "/remote/feature"))
  } finally { await page.close() }
})

test("queued clipboard reads retain paste anchors and do not delete a newer selection or reclaim focus", async () => {
  const { page } = await setup()
  try {
    await holdReads(page)
    const textarea = page.locator("textarea:visible").first()
    await textarea.fill("before AFTER")
    await textarea.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(0, 0))
    await clipboardOrDrop(page, "paste", ["held-photo.jpg"], "image/jpeg")
    await page.waitForFunction(() => Boolean((window as any).releaseRead))
    await clipboardOrDrop(page, "paste", ["second.jpg"], "image/jpeg")
    await textarea.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(7, 12))
    await page.locator("#outside").focus()
    await page.evaluate(() => (window as any).releaseRead())
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 2)
    assert.equal(await textarea.inputValue(), "[Image #1]before AFTER[Image #2]")
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
    await page.evaluate(() => (window as any).fixture.mounted(false))
    await page.evaluate(() => (window as any).fixture.mounted(true))
    assert.equal(await textarea.inputValue(), "[Image #1]before AFTER[Image #2]")
    assert.equal((await page.evaluate(() => (window as any).fixture.attachments())).length, 2)
  } finally { await page.close() }
})

test("a picker read preserves edits and focus made while its bytes are pending", async () => {
  const { page } = await setup()
  try {
    await holdReads(page)
    await (await chooseDevice(page)).setFiles({ name: "held-file.txt", mimeType: "text/plain", buffer: Buffer.from("data") })
    await page.waitForFunction(() => Boolean((window as any).releaseRead))
    await page.locator("textarea:visible").first().fill("Edited during read")
    await page.locator("#outside").focus()
    await page.evaluate(() => (window as any).releaseRead())
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    assert.equal(await page.locator("textarea:visible").first().inputValue(), "Edited during read")
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
  } finally { await page.close() }
})

test("clipboard completion places an untouched middle cursor after the token and preserves a newer selection", async () => {
  const { page } = await setup()
  try {
    const textarea = page.locator("textarea:visible").first()
    await textarea.fill("before AFTER")
    await textarea.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(7, 7))
    await clipboardOrDrop(page, "paste", ["photo.jpg"], "image/jpeg")
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    assert.equal(await textarea.inputValue(), "before [Image #1]AFTER")
    assert.deepEqual(await textarea.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd]), [17, 17])
    await textarea.press("x")
    assert.equal(await textarea.inputValue(), "before [Image #1]xAFTER")
    await holdReads(page)
    await textarea.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(0, 0))
    await clipboardOrDrop(page, "paste", ["held-second.jpg"], "image/jpeg")
    await page.waitForFunction(() => Boolean((window as any).releaseRead))
    await textarea.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(18, 23, "backward"))
    await page.evaluate(() => (window as any).releaseRead())
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 2)
    assert.deepEqual(await textarea.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection]), [28, 33, "backward"])
    assert.equal(await textarea.evaluate((input: HTMLTextAreaElement) => input.value.slice(input.selectionStart, input.selectionEnd)), "AFTER")
  } finally { await page.close() }
})
