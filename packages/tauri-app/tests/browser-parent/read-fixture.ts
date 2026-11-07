import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { NativeParent } from "../../../server/src/native-parent"
import { installShutdownStdinHandler } from "../../../server/src/shutdown"
import { BrowserPage } from "../../../server/src/automation/browser-page"
import { snapshotTree } from "../../../server/src/automation/page/semantic-tree"
import { renderSnapshot } from "../../../server/src/automation/page/snapshot"
import type { SemanticNode, PageOperation } from "../../../server/src/automation/page/protocol"

const parent=new NativeParent(process.stdout,true)
installShutdownStdinHandler(process.stdin,async()=>{},line=>parent.handleLine(line))
const [base,output]=process.argv.slice(2), checks:string[]=[]
const request=<T=Record<string,unknown>>(method:string,params:object={})=>parent.request<T>(method,{sessionID:"fixture-session",...params},20_000)
const navigate=(url:string)=>request("browser.execute",{command:{action:"navigate",url}})
const browser=new BrowserPage(parent)
async function lease() {
  const operationID=randomUUID()
  const target=await request<{generation:string;driver:string}>("browser.page.begin",{operationID})
  assert.equal(target.driver,"webkit")
  return {
    generation:target.generation,
    send:<T=Record<string,unknown>>(operation:PageOperation)=>request<T>("browser.page.send",{operationID,generation:target.generation,operation}),
    end:()=>request("browser.page.end",{operationID}),
    check:()=>request("browser.page.check",{operationID,generation:target.generation}),
  }
}
async function main() {
  assert.equal(parent.browserAutomationUnavailable,true)
  await request("browser.execute",{command:{action:"open",url:`${base}/read/preview`}})
  for(const name of ["preview","forms","edges","inputs","advanced"]) {
    await navigate(`${base}/read/${name}`)
    if(name === 'inputs') await browser.execute('fixture-session',{action:'wait',text:'Ready now',gone:false,timeout:5000})
    const current=await lease()
    const {nodes}=await current.send<{nodes:SemanticNode[]}>({op:"tree"})
    assert.ok(nodes.length)
    assert.deepEqual((await current.send<{nodes:SemanticNode[]}>({op:"tree"})).nodes,nodes)
    const snapshot=renderSnapshot(snapshotTree(nodes),id=>`n${id}`).text
    writeFileSync(join(output,`${name}.json`),JSON.stringify({nodes,snapshot},null,2))
    writeFileSync(join(output,`${name}.txt`),snapshot)
    if(name === "advanced") {
      assert.ok(!JSON.stringify(nodes).includes("never-expose-this-secret"))
      for(const label of ["First choice","Shadow label","Frame action","Closed action","Closed field","Cross-origin frame (unavailable)"]) assert.ok(snapshot.includes(label),`${label}: ${snapshot}`)
      for(const hidden of ["Hidden attribute","Hidden display","Hidden inert","Hidden ARIA","Hidden shadow action"]) assert.ok(!snapshot.includes(hidden))
      const secret=nodes.find(node=>node.role === "textbox" && node.name === "Secret")!
      const secretHandle=(await current.send({op:"resolve",node:secret.node!})).handle as string
      assert.deepEqual(await current.send({op:"call",function:"read-value",handle:secretHandle,args:[]}),{value:"•".repeat(16)})
      assert.deepEqual(await current.send({op:"call",function:"field",handle:secretHandle,args:[]}),{handle:secretHandle})
      const button=nodes.find(node=>node.role === "button" && node.name === "First choice")!
      const handle=(await current.send({op:"resolve",node:button.node!})).handle
      assert.equal(typeof handle,"string")
      await navigate(`${base}/read/advanced#stable`)
      await current.check()
      assert.equal((await current.send({op:"resolve",node:button.node!})).handle,handle)
      await request("fixture.read-mutation",{kind:"pushstate"})
      await current.check()
      assert.equal((await current.send({op:"resolve",node:button.node!})).handle,handle)
      await request("fixture.read-mutation",{kind:"reinsert"})
      assert.equal((await current.send({op:"resolve",node:button.node!})).handle,undefined)
      assert.equal((await current.send({op:"call",function:"read-value",handle:handle as string,args:[]})).exception,"codenomad:gone")
      await request("fixture.read-mutation",{kind:"recreate"})
      await assert.rejects(current.check(),/document changed|no longer current/i)
      checks.push("refs: stable snapshots/fragments/pushState; removal/reinsertion/recreation refused")
    }
    await current.end()
    checks.push(`${name}: real native semantic tree`)
  }
  await navigate(`${base}/read/advanced`)
  const snapshot=await browser.execute("fixture-session",{action:"snapshot"})
  const ref=/button "First choice" \[([^\]]+)\]/.exec(snapshot.snapshot as string)![1]
  assert.match((await browser.execute("fixture-session",{action:"snapshot",ref})).snapshot as string,/Detailed help/)
  assert.match((await browser.execute("fixture-session",{action:"snapshot",query:"Detailed help"})).snapshot as string,/First choice/)
  const current=await lease()
  await navigate(`${base}/read/preview`)
  await assert.rejects(current.check(),/document changed|no longer current/i)
  await current.end()
  await assert.rejects(browser.execute("fixture-session",{action:"snapshot",ref}),/snapshot|page/i)
  const hidden=await lease()
  await request("fixture.hide")
  await assert.rejects(hidden.check(),/current|visible/i)
  await hidden.end()
  await request("fixture.show")
  const closed=await lease()
  await request("fixture.close")
  await assert.rejects(closed.check(),/current|visible/i)
  await closed.end()
  checks.push("shared renderer scope/query; navigation/hide/close refuse stale leases and refs")
  writeFileSync(join(output,"read-result.json"),JSON.stringify({passed:true,checks},null,2))
  console.error(JSON.stringify({passed:true,checks}))
}
main().then(()=>{parent.close();process.exit(0)},error=>{
  writeFileSync(join(output,"read-result.json"),JSON.stringify({passed:false,checks,error:String(error)},null,2))
  console.error(error);parent.close();process.exit(1)
})
