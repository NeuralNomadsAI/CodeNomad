import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright"
import { CLOSED_SHADOW_HOOK } from "../packages/server/src/automation/page/webkit/hook"
import { cdpDriver } from "../packages/server/src/automation/page/cdp-driver"
import { snapshotTree } from "../packages/server/src/automation/page/semantic-tree"
import { renderSnapshot } from "../packages/server/src/automation/page/snapshot"
import type { PageOperation, SemanticNode } from "../packages/server/src/automation/page/protocol"

async function main() {
  const output=process.argv[2] ?? ".tmp/p3-comparison"
  mkdirSync(output,{recursive:true})
  const fixtures=JSON.parse(readFileSync("packages/tauri-app/tests/browser-parent/read-fixtures.generated.json","utf8")) as Record<string,string>
  fixtures.advanced=readFileSync("packages/tauri-app/tests/browser-parent/read-advanced.html","utf8")
  const server=createServer((request,response)=>{
    response.setHeader("Content-Type","text/html; charset=utf-8")
    response.end(request.url === "/read/frame" ? '<title>Child document</title><button>Frame action</button><label>Frame field <input value="Child value"></label>' : fixtures[request.url!.slice(1)]?.replace("{{CROSS}}",base.replace("127.0.0.1","localhost")))
  })
  await new Promise<void>(resolve=>server.listen(0,"0.0.0.0",resolve))
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  const browser=await chromium.launch({headless:true})
  const page=await browser.newPage()
  await page.addInitScript(CLOSED_SHADOW_HOOK)
  const cdp=await page.context().newCDPSession(page)
  await cdp.send("Accessibility.enable")
  const driver=cdpDriver({send:(method,params)=>cdp.send(method as never,params as never) as Promise<Record<string,unknown>>},async()=>{})
  const source=readFileSync("packages/server/src/automation/page/webkit/read.generated.js","utf8")
  const comparisons=[]
  const actionable=new Set(["button","link","textbox","searchbox","combobox","checkbox","radio","switch","slider","spinbutton","tab","menuitem","menuitemcheckbox","menuitemradio","option","treeitem","listbox","Date","DateTime","InputTime","ColorWell","DisclosureTriangle"])
  const signature=(node:SemanticNode)=>{
    const states=new Map(node.properties?.map(item=>[item.name,item.value]))
    const text=(value:unknown)=>String(value ?? "").replace(/\s+/g," ").trim()
    return JSON.stringify([node.role,text(node.name),text(node.description),text(node.name) === "Secret" ? "masked" : text(node.value),
      ...["disabled","required","readonly","multiselectable","checked","expanded","pressed","selected","invalid"].map(key=>String(states.get(key) ?? false))])
  }
  try {
    for (const name of Object.keys(fixtures)) {
      await page.goto(`${base}/${name}`)
      const tree=await cdp.send("Page.getFrameTree")
      const world=await cdp.send("Page.createIsolatedWorld",{frameId:tree.frameTree.frame.id,worldName:"codenomad-webkit"})
      const read=async(operation:PageOperation)=>{
        const result=await cdp.send("Runtime.evaluate",{contextId:world.executionContextId,expression:`(function(request){${source}\n})(${JSON.stringify(JSON.stringify(operation))})`,returnByValue:true})
        assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails))
        return JSON.parse(result.result.value) as {document:string;result:{nodes:SemanticNode[];handle?:string}}
      }
      const chromiumNodes=await driver.tree(), webkit=await read({op:"tree"})
      const render=(nodes:SemanticNode[],options={})=>renderSnapshot(snapshotTree(nodes),id=>`n${id}`,options).text
      const comparison={name,chromium:render(chromiumNodes),webkit:render(webkit.result.nodes),chromiumNodes,webkitNodes:webkit.result.nodes}
      const controls=(nodes:SemanticNode[])=>{
        // Compare what the shared renderer exposes, excluding native date-editor internals.
        const visible=new Set([...render(nodes).matchAll(/\[n(\d+)\]/g)].map(match=>Number(match[1])))
        return nodes.filter(node=>visible.has(node.node!) && actionable.has(String(node.role)) && !["Closed action","Frame action","Frame field"].includes(String(node.name))).map(signature).sort()
      }
      assert.deepEqual(controls(webkit.result.nodes),controls(chromiumNodes),`${name}: actionable controls differ`)
      writeFileSync(join(output,`${name}.json`),JSON.stringify(comparison,null,2))
      writeFileSync(join(output,`${name}.txt`),`CHROMIUM CDP\n${comparison.chromium}\n\nWEBKIT READER (Chromium isolated world)\n${comparison.webkit}\n`)
      comparisons.push({name,chromium:chromiumNodes.length,webkit:webkit.result.nodes.length})
      if(process.argv[3]) {
        const rows=[{engine:"Chromium CDP",text:comparison.chromium}]
        for(const engine of ["macos","x11","wayland"]) {
          const native=JSON.parse(readFileSync(join(process.argv[3],`p3-read-${engine}`,`${name}.json`),"utf8")) as {nodes:SemanticNode[];snapshot:string}
          assert.deepEqual(controls(native.nodes),controls(webkit.result.nodes),`${engine}/${name}: actionable controls differ`)
          assert.equal(native.snapshot.replace(/ \[n\d+\]/g,""),comparison.webkit.replace(/ \[n\d+\]/g,""),`${engine}/${name}: outline differs`)
          rows.push({engine,text:native.snapshot})
        }
        writeFileSync(join(output,`${name}-native.md`),`# ${name}\n\n| Engine | Snapshot |\n|---|---|\n${rows.map(row=>`| ${row.engine} | <pre>${row.text.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll("|","&#124;").replaceAll("\n","<br>")}</pre> |`).join("\n")}\n`)
      }
      const repeated=await read({op:"tree"})
      assert.equal(repeated.document,webkit.document)
      assert.deepEqual(repeated.result.nodes,webkit.result.nodes)
      if(name === "advanced") {
        assert.ok(!JSON.stringify(webkit).includes("never-expose-this-secret"))
        for(const hidden of ["Hidden attribute","Hidden display","Hidden inert","Hidden ARIA","Hidden shadow action"]) assert.ok(!comparison.webkit.includes(hidden))
        const button=webkit.result.nodes.find(node=>node.role === "button" && node.name === "First choice")!
        assert.ok(button)
        assert.match(render(webkit.result.nodes,{query:"Detailed help"}),/First choice/)
        assert.match(render(webkit.result.nodes,{rootBackendNodeId:button.node}),/First choice/)
        assert.match(render(webkit.result.nodes,{budget:200}),/hidden|more/)
        const handle=(await read({op:"resolve",node:button.node!})).result.handle
        assert.ok(handle)
        await page.evaluate(()=>{location.hash="stable"; history.pushState({},"","?same");})
        assert.equal((await read({op:"checkpoint"})).document,webkit.document)
        await page.evaluate(()=>{const item=document.querySelector("#aria-button")!;item.remove();document.querySelector("main")!.append(item)})
        assert.equal((await read({op:"resolve",node:button.node!})).result.handle,undefined)
        const recreated=(await read({op:"tree"})).result.nodes.find(node=>node.name === "First choice" && node.role === "button")!
        assert.notEqual(recreated.node,button.node)
        await page.evaluate(()=>{document.open();document.write('<title>Recreated</title><button>New document</button>');document.close()})
        assert.notEqual((await read({op:"checkpoint"})).document,webkit.document)
      }
    }
    writeFileSync(join(output,"result.json"),JSON.stringify({passed:true,comparisons},null,2))
    console.log(JSON.stringify({passed:true,comparisons}))
  } finally {await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
