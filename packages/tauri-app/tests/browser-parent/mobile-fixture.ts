import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {NativeParent} from '../../../server/src/native-parent'
import {installShutdownStdinHandler} from '../../../server/src/shutdown'
import {BrowserPage} from '../../../server/src/automation/browser-page'
const parent=new NativeParent(process.stdout,true),page=new BrowserPage(parent)
installShutdownStdinHandler(process.stdin,async()=>{},line=>parent.handleLine(line))
const [base,output]=process.argv.slice(2),request=(method:string,input:object={})=>parent.request<any>(method,{sessionID:'fixture-session',...input},20000)
const probe=(target?:string)=>request('fixture.mobile-probe',{target})
async function until(check:(v:any)=>boolean,target?:string){const end=Date.now()+8000;let last;do{try{last=await probe(target);if(check(last))return last}catch{}await new Promise(r=>setTimeout(r,40))}while(Date.now()<end);throw new Error('Mobile observation did not settle: '+JSON.stringify(last))}
async function main(){
 assert.equal(parent.browserAutomationUnavailable,false)
 await request('browser.execute',{command:{action:'open',url:base+'/mobile'}})
 await request('fixture.mobile-init',{url:base+'/mobile'})
 const primary=await until(v=>v.ua===v.httpUA,'primary'),other=await until(v=>v.ua===v.httpUA,'other'),baseline=await until(v=>v.ua===v.httpUA)
 const rows=[]
 for(const [name,width,height] of [['responsive',600,400],['desktop',1440,900],['tablet',768,1024],['tabletLandscape',1024,768],['mobile',390,844],['mobileLandscape',844,390]] as const){
  const viewport=name==='responsive'?undefined:{width,height}
  const preset=name==='mobile'||name==='mobileLandscape'?name:'none'
  await request('fixture.mobile-size',{width:600,height:400,presentation:{css:true}})
  const before=await until(v=>v.ua===v.httpUA)
  await request('fixture.mobile-profile',{preset,viewport})
  const value=await until(v=>v.inner[0]===width&&v.inner[1]===height&&v.ua===v.httpUA&&(name==='responsive'||v.load!==before.load))
  if(name!=='responsive')assert.notEqual(value.load,before.load,'changing viewport/profile reloads')
  assert.equal(value.ua.includes('(Mobile)'),preset!=='none')
  assert.deepEqual((await probe('primary')).inner,primary.inner);assert.equal((await probe('primary')).ua,primary.ua)
  assert.deepEqual((await probe('other')).inner,other.inner);assert.equal((await probe('other')).ua,other.ua)
  rows.push({name,...value});console.error(`PASS profile ${name}: ${value.inner} DPR ${value.dpr}`)
 }
 // Native renderer zoom is read by the host, rather than inferred from JS DPR.
 await request('fixture.mobile-trial',{target:'primary',zoom:1.5})
 await until(v=>v.inner[0]<primary.inner[0],'primary')
 await request('fixture.mobile-size',{width:600,height:400,presentation:{css:true,viewport:{width:390,height:844}}})
 const beforeZoomed=await probe()
 await request('fixture.mobile-profile',{preset:'mobile',viewport:{width:390,height:844}})
 const zoomed=await until(v=>v.inner[0]===390&&v.inner[1]===844&&v.ua===v.httpUA&&v.load!==beforeZoomed.load)
 const snapshot=await page.execute('fixture-session',{action:'snapshot'})
 const ref=/button "Touch target" \[([^\]]+)\]/.exec(snapshot.snapshot as string)![1]
 await page.execute('fixture-session',{action:'click',ref})
 const clicked=await until(v=>v.events.some((e:any)=>e.type==='click'))
 assert.equal(clicked.events.filter((e:any)=>e.type==='click').length,1)
 assert.ok(clicked.events.every((e:any)=>e.trusted))
 if(process.platform==='linux')assert.ok(clicked.events.some((e:any)=>e.type==='touchstart'))
 else assert.equal(clicked.events.some((e:any)=>e.type==='touchstart'),false)
 const currentLoad=clicked.load
 await request('fixture.mobile-profile',{preset:'mobile',viewport:{width:390,height:844}})
 assert.equal((await probe()).load,currentLoad,'identical profile is a no-op')
 await assert.rejects(request('fixture.mobile-profile',{preset:'arbitrary'}),/Invalid browser/)
 assert.equal((await probe()).load,currentLoad)
 await assert.rejects(request('fixture.mobile-profile',{preset:'none',viewport:{width:0,height:844}}),/Invalid browser/)
 assert.equal((await probe()).load,currentLoad)
 await request('fixture.mobile-size',{width:500,height:300,presentation:{css:true,viewport:{width:390,height:844}}})
 const resized=await until(v=>v.inner[0]===390&&v.inner[1]===844)
 assert.equal(resized.ua,clicked.ua);assert.equal(resized.load,currentLoad,'resizing retains the document/profile')
 await request('fixture.mobile-trial',{target:'primary',zoom:1})
 await request('fixture.mobile-size',{width:600,height:400,presentation:{css:true}})
 await request('fixture.mobile-profile',{preset:'none'})
 const reset=await until(v=>v.ua===baseline.ua&&v.httpUA===baseline.ua&&v.inner[0]===600&&v.inner[1]===400)
 assert.notEqual(reset.load,currentLoad)
 assert.equal((await probe('other')).ua,other.ua)
 const resetSnapshot=await page.execute('fixture-session',{action:'snapshot'})
 const resetRef=/button "Touch target" \[([^\]]+)\]/.exec(resetSnapshot.snapshot as string)![1]
 await page.execute('fixture-session',{action:'click',ref:resetRef})
 const resetClicked=await until(v=>v.events.some((e:any)=>e.type==='click'))
 assert.equal(resetClicked.events.some((e:any)=>e.type==='touchstart'),false,'reset restores mouse input')
 await request('fixture.mobile-profile',{preset:'mobile'})
 await until(v=>v.ua===clicked.ua&&v.httpUA===clicked.ua)
 await request('fixture.mobile-replace',{url:base+'/mobile'})
 const replaced=await until(v=>v.ua===baseline.ua&&v.httpUA===baseline.ua)
 assert.equal(replaced.dpr,baseline.dpr,'replacement clears profile density')
 const result={passed:true,platform:process.platform,rows,zoomed,clicked,resized,reset,resetClicked,replaced,primary,other}
 writeFileSync(output+'/mobile-result.json',JSON.stringify(result,null,2));console.error(JSON.stringify({passed:true,profiles:rows.length,zoomed:zoomed.inner,reset:reset.inner}));parent.close();process.exit(0)
}
main().catch(error=>{writeFileSync(output+'/mobile-result.json',JSON.stringify({passed:false,error:String(error)},null,2));console.error(error);parent.close();process.exit(1)})
