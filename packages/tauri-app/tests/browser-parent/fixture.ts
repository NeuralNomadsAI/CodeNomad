import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { NativeParent } from "../../../server/src/native-parent"
import { installShutdownStdinHandler } from "../../../server/src/shutdown"

const parent = new NativeParent(process.stdout, true)
installShutdownStdinHandler(process.stdin, async () => { throw new Error("Unexpected fixture shutdown command") }, line => parent.handleLine(line))
const [base, output] = process.argv.slice(2)
const request = <T = unknown>(method: string, params: unknown = {}, timeout = 15_000) => parent.request<T>(method, { sessionID: "fixture-session", ...params as object }, timeout)
const execute = async <T = {url: string}>(action: string, url?: string, timeout?: number) =>
  request<T>("browser.execute", { command: { action, url }, ...(action === "open" ? { workspaceIDs: ["fixture-tab"] } : { target: await probe() }) }, timeout)
const probe = async () => {
  const { available, target } = await request<{ available: boolean; target: string }>("browser.probe")
  assert.equal(available, true)
  assert.ok(typeof target === "string" && target.length > 0 && target.length <= 128)
  return target
}
const stale = /Browser target is stale/
async function rejectTarget(target: string | undefined, error: RegExp) {
  await assert.rejects(request("browser.page.begin", { operationID: randomUUID(), target }), error)
  await assert.rejects(request("browser.execute", { target, command: { action: "screenshot" } }), error)
  await assert.rejects(request("browser.execute", { target, command: { action: "navigate", url: `${base}/redirect` } }), error)
}
const checks: string[] = []
async function check(name: string, run: () => Promise<void>) { await run(); checks.push(name); console.error(`PASS ${name}`) }
try {
  assert.equal(parent.browserAutomationUnavailable, false, "native browser automation is available")
  await check("no preview", async () => { await assert.rejects(request("browser.probe"), /No visible/ ) })
  await check("autonomous open uses the load budget and follows the redirect", async () => {
    assert.equal((await execute("open", `${base}/open-slow`, 30_000)).url, `${base}/ok`)
    await probe()
  })
  await check("native channel requires a target", () =>
    rejectTarget(undefined, /A current browser target is required/))
  await check("visible PNG", async () => {
    const screenshot = await execute<{ image: {mime: string; data: string}; url: string }>("screenshot")
    assert.equal(screenshot.image.mime, "image/png")
    assert.ok(screenshot.image.data.length <= 16 * 1024 * 1024)
    const png = Buffer.from(screenshot.image.data, "base64")
    assert.equal(png.subarray(0,8).toString("hex"), "89504e470d0a1a0a")
    writeFileSync(join(output, "parent-capture.png"), png)
  })
  await check("fragment navigation", async () => { assert.equal((await execute("navigate", `${base}/ok#fragment`)).url, `${base}/ok#fragment`) })
  await check("cross-document redirect", async () => { assert.equal((await execute("navigate", `${base}/redirect`)).url, `${base}/ok`) })
  await check("failed load", async () => { await assert.rejects(execute("navigate", "http://127.0.0.1:1/unavailable"), /failed|load|navigation/i) })
  await execute("open", `${base}/ok`)
  await check("TLS failure", async () => {
    assert.ok(process.env.CN_FIXTURE_TLS_URL)
    await assert.rejects(execute("navigate", process.env.CN_FIXTURE_TLS_URL), /failed|load|navigation/i)
  })
  await execute("open", `${base}/ok`)
  await check("navigation deadline", async () => {
    await assert.rejects(execute("navigate", `${base}/slow`, 30), /timed out|expired/i)
  })
  await execute("open", `${base}/ok`)
  await check("hidden target", async () => {
    const target = await probe()
    await request("fixture.hide")
    await assert.rejects(request("browser.probe"), /No visible/)
    await rejectTarget(target, stale)
    await request("fixture.show")
    assert.notEqual(await probe(), target)
    await rejectTarget(target, stale)
  })
  await check("hidden renderer retires the witness after reshow", async () => {
    const target = await probe()
    await request("fixture.window-hide")
    await assert.rejects(request("browser.probe"), /No visible/)
    await request("fixture.window-show")
    assert.notEqual(await probe(), target)
    await rejectTarget(target, stale)
  })
  await check("overlay hides authority", async () => {
    await request("fixture.overlay")
    await assert.rejects(execute("screenshot"), /No visible/)
    await request("fixture.show")
  })
  await check("document recreation without native navigation retires the witness", async () => {
    const before = await probe()
    await request("fixture.read-mutation", { kind: "recreate" })
    await rejectTarget(before, stale)
    const target = await probe()
    assert.notEqual(target, before)
    const operationID = randomUUID()
    const { generation, url } = await request<{generation: string; url: string}>("browser.page.begin", { operationID, target })
    try {
      assert.equal(url, `${base}/ok`)
      const tree = await request<{ nodes: unknown[] }>("browser.page.send", { operationID, generation, operation: { op: "tree" } })
      assert.match(JSON.stringify(tree.nodes), /Recreated document/)
    } finally {
      await request("browser.page.end", { operationID })
    }
    await execute("navigate", `${base}/ok`)
  })
  await check("duplicate target", async () => {
    await request("fixture.duplicate")
    await assert.rejects(request("browser.probe"), /Multiple visible/)
    await request("fixture.removeDuplicate")
  })
  await check("native capture callback after hide", async () => {
    await assert.rejects(request("fixture.capture-hide"), /No visible/)
    await request("fixture.show")
  })
  await check("native capture callback after close", async () => {
    await assert.rejects(request("fixture.capture-close"), /No visible/)
    assert.equal((await execute("open", `${base}/ok`)).url, `${base}/ok`)
  })
  await check("late reply is discarded", async () => {
    await assert.rejects(request("fixture.late", {}, 20), /timed out/)
    await probe()
  })
  await check("close and reopen", async () => {
    await request("fixture.close")
    await assert.rejects(request("browser.probe"), /No visible/)
    assert.equal((await execute("open", `${base}/ok`)).url, `${base}/ok`)
    await request("fixture.close")
  })
  await check("retired process gets no response", async () => { await assert.rejects(request("fixture.retire", {}, 50), /timed out/) })
  writeFileSync(join(output, "parent-result.json"), JSON.stringify({passed: true, checks}, null, 2))
  parent.close()
  process.exit(0)
} catch (error) {
  writeFileSync(join(output, "parent-result.json"), JSON.stringify({passed: false, checks, error: String(error)}, null, 2))
  console.error(error)
  parent.close()
  process.exit(1)
}
