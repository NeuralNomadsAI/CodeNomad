// Every HTTP/SSE request the Solid UI makes to its local host: `node host-survey.mjs <opencode executable>`.
// The TS server of this checkout serves its own UI as the desktop hosts start it (unrestricted root), on an
// isolated daemon; the journey covers start-up, the folder picker, recents, a conversation, Files, Git, a
// worktree and every Settings section. Output: out/host-survey.json (method, route, statuses, step).
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { assertPrivateOpenCodeExecutable } from "./private-profile.mjs"

/** Route shape: identifiers, hashes and worktree slugs replaced, query keys kept without values. */
export function shape(url) {
  const route = url.pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")
    .replace(/\b(ses|msg|prt|per|que|evt)_[A-Za-z0-9]+/g, (_, kind) => `:${kind}`)
    .replace(/\/worktrees\/(?!:)[^/]+/, "/worktrees/:slug")
    .replace(/\/git-history\/[0-9a-f]{40,64}/, "/git-history/:commit")
    .replace(/\/storage\/instances\/[^/]+/, "/storage/instances/:id")
    .replace(/^\/assets\/.*|^\/[^/]+\.(js|css|svg|png|ico|webmanifest|woff2?|json)$/, "<static>")
  const keys = [...new Set(url.searchParams.keys())].sort()
  return keys.length ? `${route}?${keys.join("&")}` : route
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
const [rawExe] = process.argv.slice(2)
assert(path.isAbsolute(rawExe ?? ""), "usage: node host-survey.mjs <absolute opencode executable>")
const exe = await assertPrivateOpenCodeExecutable(rawExe)
const { chromium } = await import("playwright")
const { spawnFixtureChild: spawn, stopFixtureChild } = await import("../../../scripts/native-fixture-guards.mjs")
const { assertPrivateHost, out, privateGit, productRuntime, repo, useBenchTemp, writeJson } = await import("./fixtures.mjs")
const { populate } = await import("./files.mjs")
await useBenchTemp()
const shots = path.join(out, "screenshots", "host-survey")
await mkdir(shots, { recursive: true })
const { withProductRuntime, remove } = await productRuntime()

const observed = new Map()
let step = "startup"
const result = { steps: [], requests: [] }

async function unusedPort() {
  const socket = net.createServer()
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve))
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

try {
  await withProductRuntime(exe, async fixture => {
    await privateGit(path.join(fixture.root, "projects", "Survey Project"), "survey")
    return {}
  }, async fixture => {
    const projects = path.join(fixture.root, "projects")
    await populate(path.join(projects, "Survey Project"))
    await writeFile(path.join(fixture.root, "ts.yaml"), `server:\n  opencodeBinary: ${JSON.stringify(exe)}\nui:\n  settings:\n    locale: en\n`)
    const password = randomUUID(), port = await unusedPort(), origin = `http://127.0.0.1:${port}`
    const info = await fixture.client.server.info()
    const env = { ...fixture.env, CNRS_FIXTURE_URL: fixture.connection.endpoint.url, CNRS_FIXTURE_PASSWORD: fixture.connection.endpoint.auth.password,
      CNRS_FIXTURE_PID: String(info.pid), CODENOMAD_SERVER_PASSWORD: password, CODENOMAD_REMOTE_CONTROL: "disabled" }
    await assertPrivateHost(env, fixture.root, path.join(fixture.root, "ts.yaml"))
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "ts-server.mjs"), "--http", "true", "--http-port", String(port), "--https", "false",
      "--ui-no-update", "--ui-dir", path.join(repo, "packages/server/public"), "--config", path.join(fixture.root, "ts.yaml"), "--unrestricted-root"],
      { env, cwd: fixture.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const stopped = new Promise(resolve => child.once("close", resolve))
    let output = ""
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data })
    let browser
    try {
      for (const end = Date.now() + 60000; !output.includes("Local Connection URL"); await delay(100)) {
        assert(Date.now() < end && child.exitCode === null, `TS startup: ${output.slice(-2000)}`)
      }
      const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "codenomad", password }) })
      assert.equal(login.status, 200)
      const cookie = login.headers.get("set-cookie").split(";", 1)[0]
      browser = await chromium.launch({ headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH })
      const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 960 } })
      await context.addCookies([{ name: "codenomad_session", value: cookie.split("=")[1], url: origin, httpOnly: true, sameSite: "Lax" }])
      const page = await context.newPage()
      page.setDefaultTimeout(30000)
      page.on("response", res => {
        const url = new URL(res.url())
        if (url.origin !== origin) return
        const key = `${res.request().method()} ${shape(url)}`
        const row = observed.get(key) ?? { method: res.request().method(), route: shape(url), statuses: {}, steps: [] }
        row.statuses[res.status()] = (row.statuses[res.status()] ?? 0) + 1
        if (!row.steps.includes(step)) row.steps.push(step)
        observed.set(key, row)
      })
      const inflight = new Map()
      page.on("request", req => { const u = new URL(req.url()); if (u.origin === origin && !u.pathname.endsWith("/events")) inflight.set(req, `${req.method()} ${shape(u)}`) })
      for (const done of ["requestfinished", "requestfailed"]) page.on(done, req => inflight.delete(req))
      result.inflight = () => [...inflight.values()]
      page.on("pageerror", e => console.log("PAGE ERROR", String(e)))
      const eye = (row, name) => page.locator(row).filter({ hasText: name, visible: true })
        .getByRole("button", { name: new RegExp(` · ${name.replace(".", "\\.")}$`) }).first()
      const at = async (name, action) => {
        step = name
        console.log("step", name, new Date().toISOString())
        await action()
        await delay(1500)
        await page.screenshot({ path: path.join(shots, `${result.steps.length}-${name}.png`), timeout: 15000 })
        result.steps.push(name)
      }
      await at("startup", async () => {
        await page.goto(origin, { waitUntil: "domcontentloaded" })
        await page.getByText("Browse Folders", { exact: true }).waitFor()
      })
      await at("folder-picker", async () => {
        await page.getByText("Browse Folders", { exact: true }).click()
        const dialog = page.getByRole("dialog")
        await dialog.getByText("projects", { exact: true }).click()
        await dialog.getByText("Survey Project", { exact: true }).waitFor()
        await dialog.getByRole("button", { name: "New Folder", exact: true }).click()
        await page.getByPlaceholder("e.g. my-new-project").fill("Created Folder")
        await page.getByRole("button", { name: "Create", exact: true }).click()
        // The picker enters the new folder.
        await dialog.getByText("Survey Project", { exact: true }).waitFor({ state: "hidden" })
        await dialog.getByText("Up one level", { exact: true }).click()
        await dialog.getByText("Created Folder", { exact: true }).waitFor()
      })
      await at("open-project", async () => {
        const row = page.getByRole("dialog").locator("div,li,button").filter({ hasText: /^Survey Project/ }).filter({ has: page.getByRole("button", { name: "Select", exact: true }) }).last()
        await row.getByRole("button", { name: "Select", exact: true }).click()
        await page.getByPlaceholder(/type your message/i).first().waitFor()
      })
      await at("conversation", async () => {
        await page.getByPlaceholder(/type your message/i).first().fill("Réponds avec le texte synthétique du banc de test.")
        await page.getByRole("button", { name: "Send message", exact: true }).click()
        await page.getByText("FIXTURE_ANSWER", { exact: true }).first().waitFor()
        await page.getByText("WORKING", { exact: true }).filter({ visible: true }).first().waitFor({ state: "hidden" })
      })
      await at("files", async () => {
        await page.getByRole("tab", { name: "Files", exact: true }).click()
        await eye(".workspace-tree-row", "Editable.txt").click()
        await page.locator(".monaco-editor").filter({ visible: true }).first().waitFor()
      })
      await at("git", async () => {
        await page.getByRole("button", { name: "Changes", exact: true }).click()
        await eye(".git-panel-file-row", "large.txt").click()
        await page.locator(".monaco-diff-editor").filter({ visible: true }).waitFor()
        await page.getByRole("button", { name: "Commits", exact: true }).click()
      })
      await at("worktree", async () => {
        // The selector and its creation dialog only: creating a worktree with a session move stays pending on
        // this TS fixture; POST/DELETE /worktrees are compared by the `http` mode.
        const trigger = page.locator("button.selector-trigger").filter({ hasText: /Worktree:/i }).filter({ visible: true }).first()
        await trigger.click()
        await page.getByText("New from current branch", { exact: true }).click()
        await page.getByPlaceholder("worktree-name").fill("survey-worktree")
        await page.getByRole("button", { name: "Cancel", exact: true }).click()
      })
      await at("recents", async () => {
        await page.getByRole("button", { name: "New instance", exact: true }).click()
        await page.getByText("Recent Folders", { exact: true }).waitFor()
        await page.getByText("Survey Project", { exact: true }).first().waitFor()
      })
      await at("settings", async () => {
        await page.getByRole("button", { name: "Open settings", exact: true }).filter({ visible: true }).last().click()
        const nav = page.getByRole("navigation", { name: "Settings sections" })
        await nav.waitFor()
        for (const section of await nav.getByRole("button").allInnerTexts()) {
          step = `settings:${section.trim()}`
          await nav.getByRole("button", { name: section.trim(), exact: true }).click()
          await delay(1200)
        }
        step = "settings"
        await page.getByRole("button", { name: "Close settings", exact: true }).click()
      })
    } catch (error) {
      console.log("IN FLIGHT", JSON.stringify(result.inflight?.()), "at", step)
      await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {})
      throw error
    } finally {
      await browser?.close()
      if (child.exitCode === null) await stopFixtureChild(child, stopped)
      await writeFile(path.join(out, "host-survey-ts.log"), output.replaceAll(password, "<redacted>"))
    }
  })
} catch (error) {
  result.error = String(error.stack)
  console.error(result.error)
  process.exitCode = 1
} finally {
  await remove()
  result.requests = [...observed.values()].sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method))
  await writeJson("host-survey.json", result)
  console.log(`host-survey: ${result.error ? "FAILED" : `${result.requests.length} routes`} → ${path.join(out, "host-survey.json")}`)
}
}
