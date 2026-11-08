import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { chromium } from "playwright"
import { CLOSED_SHADOW_HOOK } from "../../../server/src/automation/page/webkit/hook"
import { declaration } from "../../../server/src/automation/page/functions"
import type { PageOperation } from "../../../server/src/automation/page/protocol"

test("WebKit reader finds composed text and accepts shadow descendants without accepting overlays", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.addInitScript(CLOSED_SHADOW_HOOK)
    await page.goto("data:text/html," + encodeURIComponent(`<!doctype html><p>Hello <b>world</b></p>
      <iframe srcdoc="<p>Frame <b>phrase</b></p>"></iframe>
      <script>for(const mode of ['open','closed']) {
        const host=document.createElement('x-button');host.id=mode;host.role='button';host.ariaLabel=mode+' Host action';
        host.style='display:block;width:160px;height:40px';
        host.attachShadow({mode}).innerHTML='<span style="display:block;width:100%;height:100%">Shadow <b>phrase</b></span>';
        host.onclick=event=>host.dataset.clicked=event.isTrusted;document.body.append(host);
      }</script>`))
    const cdp = await page.context().newCDPSession(page)
    const tree = await cdp.send("Page.getFrameTree")
    const world = await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "codenomad-webkit" })
    const source = readFileSync(new URL("../../../server/src/automation/page/webkit/read.generated.js", import.meta.url), "utf8")
    const read = async (operation: PageOperation) => {
      const response = await cdp.send("Runtime.evaluate", { contextId: world.executionContextId,
        expression: `(function(request){${source}\n})(${JSON.stringify(JSON.stringify(operation))})`, returnByValue: true })
      assert.equal(response.exceptionDetails, undefined)
      return JSON.parse(response.result.value).result
    }
    const root = (await read({ op: "call", function: "document-root", args: [] })).handle
    const contains = async (text: string) => (await read({ op: "call", function: "contains", handle: root, args: [text] })).value
    for (const text of ["Hello world", "Frame phrase", "Shadow phrase"]) assert.equal(await contains(text), true, text)
    // A gone wait must keep polling while the phrase is present, then succeed after removal.
    assert.equal(await contains("Hello world"), true)
    await page.locator("p").first().evaluate(element => element.remove())
    assert.equal(await contains("Hello world"), false)
    const nodes = (await read({ op: "tree" })).nodes
    for (const mode of ["open", "closed"]) {
      const host = nodes.find((node: any) => node.name === `${mode} Host action`)
      const handle = (await read({ op: "resolve", node: host.node })).handle
      const quad = (await read({ op: "geometry", node: host.node })).quads[0]
      const x = (quad[0] + quad[4]) / 2, y = (quad[1] + quad[5]) / 2
      const hit = (await read({ op: "hit-test", x, y })).node
      assert.notEqual(hit, host.node, "deep hit test returns the shadow descendant")
      const hitHandle = (await read({ op: "resolve", node: hit })).handle
      assert.equal((await read({ op: "call", function: "receives", handle, args: [{ handle: hitHandle }] })).value, null)
      await page.mouse.click(x, y)
      assert.equal(await page.locator(`#${mode}`).getAttribute("data-clicked"), "true")
    }
    // The shared CDP program gets the same composed-ancestry fix, including slot ancestry.
    assert.deepEqual(await page.evaluate(source => {
      const host = document.querySelector("#open")!, root = host.shadowRoot!
      root.innerHTML = '<section><slot></slot></section>'
      const child = document.createElement("span"); host.append(child)
      const receives = new Function(`return (${source})`)()
      return [receives.call(host, child), receives.call(root.querySelector("section"), child), receives.call(host, document.querySelector("iframe"))]
    }, declaration("receives", false)), [null, null, "iframe"])
  } finally { await browser.close() }
})
