import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { chromium, webkit } from "playwright"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { nativeDriver } from "../../../server/src/automation/page/native-driver"
import { performAction } from "../../../server/src/automation/page/actions"
import { aim } from "../../../server/src/automation/page/input"
import { PageDriverUnsupportedError, type PageOperation } from "../../../server/src/automation/page/protocol"

// WEBKIT_GEOMETRY_ENGINE=webkit replays these same actions on native WebKit on Linux.
test("WebKit affine frame aiming agrees with native input, including reflected and nested frames", { timeout: 60_000 }, async () => {
  const browser = await (process.env.WEBKIT_GEOMETRY_ENGINE === "webkit" ? webkit : chromium).launch({ headless: true })
  armFixtureNavigationBudget(browser)
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    const source = readFileSync(new URL("../../../server/src/automation/page/webkit/read.generated.js", import.meta.url), "utf8")
    let inputs = 0
    const read = async (operation: PageOperation) => {
      if (operation.op === "pointer") {
        inputs++
        const e = operation.event
        if (e.type === "mouseMoved") await page.mouse.move(e.x, e.y)
        else if (e.type === "mousePressed") await page.mouse.down()
        else await page.mouse.up()
        return {}
      }
      if (operation.op === "wheel") { inputs++; await page.mouse.wheel(operation.event.deltaX, operation.event.deltaY); return {} }
      return page.evaluate(({ source, operation }) => JSON.parse(new Function("request", source)(JSON.stringify(operation))).result, { source, operation })
    }
    const session = { driver: nativeDriver({ driver: "webkit", contractVersion: 1 }, read, async () => {}), markAutomation: false, checkpoint: async () => {} }
    for (const transform of ["rotate(180deg)", "scale(-1,1)", "rotate(31deg) skewX(12deg)", "translate(13px,9px) scale(0.8,1.1)", "ancestor", "nested", "top-level"]) {
      await page.setContent(`<style>body{margin:0}iframe{position:absolute;left:250px;top:250px;width:320px;height:240px;border:3.5px solid;padding:4px;transform-origin:23px 47px}</style><div id="ancestor"><iframe></iframe></div>`)
      await page.locator("iframe").evaluate((frame, transform) => {
        const contents = `<style>body{margin:0;height:2000px}button{position:absolute;width:100px;height:40px}#target{left:10px;top:10px}#other{left:210px;top:10px}#bottom{left:210px;top:190px}</style><button id="target">Target</button><button id="other">Other</button><button id="bottom">Bottom</button><script>document.addEventListener('click',e=>document.body.dataset.clicked=e.target.id+':'+e.isTrusted);document.addEventListener('pointerup',e=>document.body.dataset.up=e.target.id);document.addEventListener('wheel',e=>document.body.dataset.wheel=e.isTrusted)</script>`
        if (transform === "ancestor") frame.parentElement!.style.cssText = "transform:rotate(180deg) scale(-1,1);transform-origin:400px 300px"
        else if (transform === "nested") frame.style.transform = "rotate(180deg)"
        else if (transform !== "top-level") frame.style.transform = transform
        frame.srcdoc = transform === "nested" ? `<iframe style="width:320px;height:240px;border:0;transform:scale(-1,1)" srcdoc="${contents.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>` : contents
      }, transform)
      await page.waitForFunction(() => {
        const frame = document.querySelector("iframe")!
        return !!(frame.contentDocument!.querySelector("#target") ?? frame.contentDocument!.querySelector("iframe")?.contentDocument?.querySelector("#target"))
      })
      if (transform === "top-level") await page.evaluate(() => {
        document.body.innerHTML = '<button id="target" style="position:absolute;left:200px;top:200px;width:100px;height:40px;transform:rotate(180deg) scale(-1,1)">Target</button><button id="other" style="position:absolute;left:400px;top:200px">Other</button>'
        document.addEventListener("click", e => document.body.dataset.clicked = (e.target as Element).id + ":" + e.isTrusted)
        document.addEventListener("pointerup", e => document.body.dataset.up = (e.target as Element).id)
        document.addEventListener("wheel", e => document.body.dataset.wheel = String(e.isTrusted))
      })
      const state = () => page.evaluate(() => {
        let doc = document
        while (doc.querySelector("iframe")) doc = doc.querySelector("iframe")!.contentDocument!
        return { ...doc.body.dataset }
      })
      const nodes = (await read({ op: "tree" })).nodes
      const target = nodes.find((n: any) => n.name === "Target" && n.role === "button").node
      const other = nodes.find((n: any) => n.name === "Other" && n.role === "button").node
      const point = await aim(session, "target", target)
      assert.ok(point, transform)
      assert.equal((await read({ op: "hit-test", ...point })).node, target, transform)
      const handle = (await read({ op: "resolve", node: target })).handle
      assert.equal((await read({ op: "call", function: "receives", handle, args: [{ handle }] })).value, null)
      await performAction(session, { kind: "click", ref: "target", backendNodeId: target })
      assert.equal((await state()).clicked, "target:true", transform)
      const clicked = (await state()).clicked
      await performAction(session, { kind: "hover", ref: "target", backendNodeId: target })
      await performAction(session, { kind: "drag", ref: "target", backendNodeId: target, to: { ref: "other", backendNodeId: other } })
      assert.equal((await state()).up, "other", transform)
      await performAction(session, { kind: "scroll", target: { ref: "target", backendNodeId: target }, direction: "down", amount: 20 })
      await page.waitForTimeout(100)
      assert.equal((await state()).wheel, "true", transform)
      console.log(JSON.stringify({ transform, reportedHit: "target", receives: null, clicked, drag: "other", wheel: "trusted" }))
    }
    for (const transform of ["perspective(400px) rotateY(30deg)", "scale(0)"]) {
      await page.setContent(`<div style="height:2000px"></div><iframe style="transform:${transform}" srcdoc="<button>Target</button>"></iframe>`)
      await page.waitForFunction(() => document.querySelector("iframe")!.contentDocument!.querySelector("button"))
      const target = (await read({ op: "tree" })).nodes.find((n: any) => n.name === "Target").node
      const before = inputs
      for (const kind of ["click", "hover", "scroll", "drag"] as const) {
        const action = kind === "scroll" ? { kind, target: { ref: "target", backendNodeId: target }, direction: "down" as const, amount: 20 }
          : kind === "drag" ? { kind, ref: "target", backendNodeId: target, to: { ref: "target", backendNodeId: target } }
          : { kind, ref: "target", backendNodeId: target }
        await assert.rejects(performAction(session, action), PageDriverUnsupportedError)
      }
      assert.equal(inputs, before, "unsupported transforms must not send native input")
      assert.equal(await page.evaluate(() => scrollY), 0, "unsupported transforms must not scroll")
    }
  } finally { await browser.close() }
})
