import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { chromium } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { CLOSED_SHADOW_HOOK } from "../../../server/src/automation/page/webkit/hook"
import { declaration } from "../../../server/src/automation/page/functions"
import { nativeDriver } from "../../../server/src/automation/page/native-driver"
import { waitForText } from "../../../server/src/automation/page/input"
import { performAction } from "../../../server/src/automation/page/actions"
import type { PageOperation } from "../../../server/src/automation/page/protocol"

test("WebKit reader finds composed text and accepts shadow descendants without accepting overlays", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  armFixtureNavigationBudget(browser)
  try {
    const page = await browser.newPage()
    await page.addInitScript(CLOSED_SHADOW_HOOK)
    await page.goto("data:text/html," + encodeURIComponent(`<!doctype html><p>Hello <b>world</b></p>
      <div id="word">Au<span>then</span>tication</div>
      <div>BlockAlpha</div><div>BlockBeta</div><span>LineAlpha</span><br><span>LineBeta</span>
      <span>HiddenAlpha</span><span hidden>ignored</span><span>HiddenBeta</span>
      <div style="display:flex"><span>Flex</span><span>words</span></div>
      <div style="display:grid"><span>GridAlpha</span><span>GridBeta</span></div>
      <table><tr><td>CellAlpha</td><td>CellBeta</td></tr></table>
      <ul><li>ListAlpha</li><li>ListBeta</li></ul>
      <iframe title="Scrollable frame" srcdoc="<p>Frame <b>phrase</b></p><div style='height:2000px' onclick='document.body.dataset.clicked=event.isTrusted'></div>"></iframe>
      <script>for(const mode of ['open','closed']) {
        const host=document.createElement('x-button');host.id=mode;host.role='button';host.ariaLabel=mode+' Host action';
        host.style='display:block;width:160px;height:40px';
        host.attachShadow({mode}).innerHTML='<span style="display:block;width:100%;height:100%">Shadow <b>phrase</b></span><span>Auth<span>enti</span>cated</span><slot></slot>';
        host.innerHTML='Slot<span>ted</span>';
        host.onclick=event=>host.dataset.clicked=event.isTrusted;document.body.append(host);
      }</script>`))
    const cdp = await page.context().newCDPSession(page)
    const tree = await cdp.send("Page.getFrameTree")
    const world = await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "codenomad-webkit" })
    const source = readFileSync(new URL("../../../server/src/automation/page/webkit/read.generated.js", import.meta.url), "utf8")
    const read = async (operation: PageOperation) => {
      if (operation.op === "pointer" || operation.op === "wheel") {
        await cdp.send("Input.dispatchMouseEvent", operation.event)
        return {}
      }
      const response = await cdp.send("Runtime.evaluate", { contextId: world.executionContextId,
        expression: `(function(request){${source}\n})(${JSON.stringify(JSON.stringify(operation))})`, returnByValue: true })
      assert.equal(response.exceptionDetails, undefined)
      return JSON.parse(response.result.value).result
    }
    const root = (await read({ op: "call", function: "document-root", args: [] })).handle
    const session = { driver: nativeDriver({ driver: "webkit", contractVersion: 1 }, read, async () => {}),
      markAutomation: false, checkpoint: async () => {} }
    const contains = async (text: string) => (await read({ op: "call", function: "contains", handle: root, args: [text] })).value
    for (const text of ["Hello world", "Authentication", "Frame phrase", "Shadow phrase", "Authenticated", "Slotted", "BlockAlpha BlockBeta", "LineAlpha LineBeta", "HiddenAlpha HiddenBeta", "Flex words", "GridAlpha GridBeta", "CellAlpha CellBeta", "ListAlpha ListBeta"]) assert.equal(await contains(text), true, text)
    for (const text of ["BlockAlphaBlockBeta", "LineAlphaLineBeta", "HiddenAlphaHiddenBeta", "GridAlphaGridBeta", "CellAlphaCellBeta", "ListAlphaListBeta"]) assert.equal(await contains(text), false, text)
    assert.equal((await waitForText(session, "Authentication", false, 500)).found, true)
    await assert.rejects(waitForText(session, "Authentication", true, 50), /still shown/)
    await page.locator("#word").evaluate(element => element.remove())
    assert.equal((await waitForText(session, "Authentication", true, 500)).found, false)
    assert.equal((await waitForText(session, "Hello world", false, 500)).found, true)
    await assert.rejects(waitForText(session, "Hello world", true, 50), /still shown/)
    await page.locator("p").first().evaluate(element => element.remove())
    assert.equal((await waitForText(session, "Hello world", true, 500)).found, false)
    const nodes = (await read({ op: "tree" })).nodes
    const frame = nodes.find((node: any) => node.role === "Iframe")
    await performAction(session, { kind: "click", ref: "frame", backendNodeId: frame.node })
    await page.waitForFunction(() => (document.querySelector("iframe")!.contentDocument!.body.dataset.clicked === "true"))
    await performAction(session, { kind: "scroll", target: { ref: "frame", backendNodeId: frame.node }, direction: "down", amount: 200 })
    await page.waitForFunction(() => document.querySelector("iframe")!.contentWindow!.scrollY > 0)
    // The shared CDP program accepts same-origin document ancestry and rejects unrelated hits.
    assert.deepEqual(await page.evaluate(source => {
      const frame = document.querySelector("iframe")!, receives = new Function(`return (${source})`)()
      return [receives.call(frame, frame.contentDocument!.body), receives.call(document.body, frame.contentDocument!.body), typeof receives.call(frame, document.body)]
    }, declaration("receives", false)), [null, null, "string"])
    await page.locator("iframe").evaluate(frame => {
      frame.setAttribute("aria-disabled", "true")
      frame.contentDocument!.body.insertAdjacentHTML("beforeend", '<input aria-label="Frame disabled field">')
    })
    const frameField = (await read({ op: "tree" })).nodes.find((node: any) => node.name === "Frame disabled field")
    assert.ok(frameField.properties.some((property: any) => property.name === "disabled" && property.value === true), "disabled state crosses frame ancestry")
    await page.locator("iframe").evaluate(frame => frame.setAttribute("inert", ""))
    assert.equal(await contains("Frame phrase"), false, "frame ancestors hide child-document text")
    await page.locator("iframe").evaluate(frame => frame.removeAttribute("inert"))
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
    }, declaration("receives", false)), [null, null, 'iframe "Scrollable frame"'])
    assert.equal(await page.evaluate(source => {
      const input = document.createElement("input"); input.id = "labelled-control"; document.body.append(input)
      const label = document.createElement("label"); label.htmlFor = input.id
      const host = document.createElement("span"); label.append(host); document.body.append(label)
      const root = host.attachShadow({ mode: "open" }); root.innerHTML = "<span>Label text</span>"
      return new Function(`return (${source})`)().call(input, root.firstChild)
    }, declaration("receives", false)), null, "associated labels work through shadow ancestry")
    await page.locator("#open").evaluate(host => {
      host.shadowRoot!.innerHTML = '<slot aria-hidden="true"></slot>'
      host.innerHTML = '<span>Hidden slotted text</span>'
    })
    assert.equal(await contains("Hidden slotted text"), false, "slot ancestors hide assigned text")
    await page.locator("#open").evaluate(host => {
      host.shadowRoot!.innerHTML = '<slot aria-disabled="true"></slot>'
      host.innerHTML = '<input aria-label="Slot disabled field">'
    })
    const slotField = (await read({ op: "tree" })).nodes.find((node: any) => node.name === "Slot disabled field")
    assert.ok(slotField.properties.some((property: any) => property.name === "disabled" && property.value === true), "disabled state crosses slot ancestry")
  } finally { await browser.close() }
})
