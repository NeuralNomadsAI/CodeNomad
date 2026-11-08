import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NativeParent } from '../../../server/src/native-parent'
import { installShutdownStdinHandler } from '../../../server/src/shutdown'
import { BrowserPage } from '../../../server/src/automation/browser-page'
import { parsePageAction } from '../../../server/src/automation/page/parse'
import { nativeDriver } from '../../../server/src/automation/page/native-driver'
import { actionScenarios } from './action-scenarios'
process.setSourceMapsEnabled(true)
const parent=new NativeParent(process.stdout,true),browser=new BrowserPage(parent)
installShutdownStdinHandler(process.stdin,async()=>{},line=>parent.handleLine(line))
const [base,output]=process.argv.slice(2),engine=process.platform==='darwin'?'macos':output.includes('wayland')?'wayland':'x11'
const request=<T=any>(method:string,params:object={},timeout=20_000)=>parent.request<T>(method,{sessionID:'fixture-session',...params},timeout)
const control=(kind:string)=>request('fixture.action-control',{kind})
const observe=()=>request('fixture.action-probe')
async function main(){
  assert.equal(parent.browserAutomationUnavailable,true)
  await request('browser.execute',{command:{action:'open',url:`${base}/read/preview`}})
  const result=await actionScenarios({
    navigate:name=>{console.error(`action fixture: ${name}`);return request('browser.execute',{command:{action:'navigate',url:`${base}/read/${name}`}})},
    snapshot:async()=>(await browser.execute('fixture-session',{action:'snapshot'})).snapshot as string,
    act:action=>{console.error(`action: ${action.action}${action.key?` ${action.key}`:''}`);return browser.execute('fixture-session',parsePageAction(action,'snapshot')!)},observe,control,
  },engine)
  for(const admitted of [false,true]) {
    await request('browser.execute',{command:{action:'navigate',url:`${base}/read/inputs`}})
    const operationID=randomUUID(),descriptor=await request('browser.page.begin',{operationID})
    const send=(operation:any,timeout?:number)=>request('browser.page.send',{operationID,generation:descriptor.generation,operation},timeout)
    const driver=nativeDriver(descriptor,operation=>send(operation),async()=>{})
    const target=(await driver.tree()).find(node=>node.role==='button' && node.name==='Hover me')!
    const quad=(await driver.geometry(target.node!))[0],x=(quad[0]+quad[4])/2,y=(quad[1]+quad[5])/2
    const pointer={type:'mousePressed' as const,x,y,button:'left' as const,buttons:1,clickCount:1}
    if(admitted) {
      await control('arm-busy-click')
      await assert.rejects(send({op:'pointer',event:pointer},150),/expired|timed out|timeout/i)
    } else {
      await driver.pointer(pointer)
      const query=(await driver.tree()).find(node=>node.role==='textbox' && node.name==='Query')!
      await driver.call('focus',await driver.resolve(query.node!),[])
      await driver.keyboard({type:'rawKeyDown',key:'Shift',code:'ShiftLeft',modifiers:8})
      await control('busy')
      await assert.rejects(send({op:'insert-text',text:'MUST-NOT-REPLAY'},20),/expired|timed out|timeout/i)
    }
    await request('browser.page.end',{operationID})
    const observed=await observe();result.observations[admitted?'admittedTimeout':'queuedTimeout']=observed
    writeFileSync(join(output,'action-observations.json'),JSON.stringify(result,null,2))
    assert.equal(observed.audit.filter((event:any)=>event.type==='pointerdown').length,1)
    assert.equal(observed.audit.filter((event:any)=>event.type==='pointerup').length,1)
    if(!admitted) assert.ok(observed.audit.some((event:any)=>event.type==='keyup' && event.key==='Shift'))
    assert.ok(!JSON.stringify(observed.fields).includes('MUST-NOT-REPLAY'))
  }
  result.checks.push('native parent timeouts: queued mutation refused, admitted pointer not replayed; held pointer/key released on exact lease end')
  writeFileSync(join(output,'action-result.json'),JSON.stringify(result,null,2))
  console.error(JSON.stringify({passed:true,engine,checks:result.checks,limitations:result.limitations}))
}
main().then(()=>{parent.close();process.exit(0)},error=>{writeFileSync(join(output,'action-result.json'),JSON.stringify({passed:false,engine,error:String(error)},null,2));console.error(error);parent.close();process.exit(1)})
