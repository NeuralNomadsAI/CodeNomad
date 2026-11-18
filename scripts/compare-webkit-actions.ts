import { createServer } from 'node:http'
import assert from 'node:assert/strict'
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
  const server=createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end((request.url==='/read/frame'?'<title>Child document</title><button onclick="document.body.dataset.clicked=event.isTrusted">Frame action</button><label>Frame field <input value="Child value"></label>':fixtures[request.url!.slice(6)]?.replace('{{CROSS}}',base.replace('127.0.0.1','localhost')))+'<script>'+ACTION_AUDITOR+'</script>')})
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
    if(process.argv[3]) {
      const fields=(value:any)=>Object.fromEntries(Object.entries(value.fields).sort().map(([id,raw])=>{
        const item=raw as any
        return [id,{value:typeof item.html==='string' && typeof item.value==='string' && !item.value.trim()?'':item.value,checked:item.checked??null,selected:item.selected??null}]
      }))
      const rows=[]
      for(const engine of ['macos','x11','wayland']) {
        const native=JSON.parse(readFileSync(`${process.argv[3]}/p4-actions-${engine}/action-result.json`,'utf8'))
        assert.equal(native.passed,true)
        const differences=[...native.limitations]
        for(const key of ['preview','forms','edges','inputs','closed','richEnter','modThenEnter']) {
          const actual=fields(native.observations[key]),expected=fields(result.observations[key])
          if(key==='edges' && actual.story.value===expected.story.value+'\n' && native.observations.edges.fields.story.html===result.observations.edges.fields.story.html) {
            differences.push('Inactive contenteditable behind a modal has one trailing innerText newline; its HTML is unchanged')
            actual.story.value=expected.story.value
          }
          assert.deepEqual(actual,expected,`${engine}/${key}: normalized fields differ`)
        }
        rows.push({engine,passed:true,limitations:differences,emptyEditor:{chromium:result.observations.modThenEnter,native:native.observations.modThenEnter}})
      }
      writeFileSync(output+'/comparison.json',JSON.stringify({passed:true,rows},null,2))
      writeFileSync(output+'/comparison.md',`# Native actions versus Chromium\n\nNormalized field values, checkbox/option state and native text results match across the shared fixtures. Empty contenteditable serialization is retained in the JSON evidence.\n\n| Engine | Assertions | Differences |\n|---|---|---|\n${rows.map(row=>`| ${row.engine} | Passed | ${row.limitations.join('; ')||'None on these action flows'} |`).join('\n')}\n\nDeclarative closed roots render on every engine; only CDP exposes their controls. WebKit also reads and acts inside same-origin frames, whose contents are absent from the main-frame CDP snapshot. Native-only queued/admitted timeout cases verify exact-lease releases without mutation replay.\n`)
    }
  } finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
