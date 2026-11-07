import { createServer } from 'node:http'
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { cdpSession } from '../packages/server/src/automation/page/cdp-driver'
import { snapshotPage,performAction,bindRefs } from '../packages/server/src/automation/page/actions'
import { RefTable } from '../packages/server/src/automation/page/refs'
import { parsePageAction } from '../packages/server/src/automation/page/parse'
import { actionScenarios } from '../packages/tauri-app/tests/browser-parent/action-scenarios'
import { ACTION_AUDITOR,ACTION_PROGRAMS } from '../packages/tauri-app/tests/browser-parent/action-programs'
async function main(){
  const output=process.argv[2]||'.tmp/p4-comparison';mkdirSync(output,{recursive:true})
  const directory='packages/tauri-app/tests/browser-parent/'
  const fixtures=JSON.parse(readFileSync(directory+'read-fixtures.generated.json','utf8'))
  fixtures.advanced=readFileSync(directory+'read-advanced.html','utf8');fixtures.extra=readFileSync(directory+'action-extra.html','utf8')
  const server=createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end((request.url==='/read/frame'?'<title>Child document</title><button>Frame action</button><label>Frame field <input value="Child value"></label>':fixtures[request.url!.slice(6)]?.replace('{{CROSS}}',base.replace('127.0.0.1','localhost')))+'<script>'+ACTION_AUDITOR+'</script>')})
  await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:600,height:400}})
  const cdp=await page.context().newCDPSession(page);await cdp.send('Accessibility.enable')
  const session=cdpSession({send:(method,params)=>cdp.send(method as never,params as never) as Promise<Record<string,unknown>>},async()=>{},false)
  const refs=new RefTable('snapshot','e');let generation=0
  try {
    const result=await actionScenarios({
      navigate:async name=>{generation++;await page.goto(`${base}/read/${name}`)},
      snapshot:async()=>(await snapshotPage(session,()=>refs.issuer(String(generation)))).text,
      act:async value=>performAction(session,bindRefs(parsePageAction(value,'snapshot')!,ref=>refs.resolve(ref,String(generation)))) as Promise<Record<string,unknown>>,
      control:async kind=>{await page.evaluate(ACTION_PROGRAMS[kind as keyof typeof ACTION_PROGRAMS])},
      observe:async()=>{await page.evaluate(ACTION_PROGRAMS.observe);const value=await page.locator('#__cn_probe').textContent();await page.evaluate(ACTION_PROGRAMS['remove-probe']);return JSON.parse(value!.slice('__CN_PROBE__'.length))},
    },'chromium')
    writeFileSync(output+'/chromium.json',JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks}))
  } finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
