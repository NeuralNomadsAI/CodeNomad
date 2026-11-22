import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {installPngReader} from '../png-pixels.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url))
const {values}=parseArgs({options:{thresholds:{type:'string'}}})
const out=path.join(root,'target/rune-parity/action-menu')
const solid=JSON.parse(await readFile(path.join(out,'solid-evidence.json'),'utf8'))
const native=JSON.parse(await readFile(path.join(root,'target/rune-action-menu/native-captures.json'),'utf8'))
assert(!solid.records.some(r=>r.failure),'Finish the actual Solid fixture first')
const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex')
assert.equal(await digest(native.provenance.binary.path),native.provenance.binary.sha256,'Stale native binary')
assert.equal(await digest(path.join(root,'scripts/rune/parity/action-menu-native.mjs')),native.provenance.fixtureSha256,'Stale native fixture')
assert.equal(await digest(path.join(root,'crates/rune-theme-codenomad/assets/theme.json')),native.provenance.themeSha256,'Stale native theme')
for(const [file,digest] of Object.entries(solid.provenance)){
  assert.equal(createHash('sha256').update(await readFile(path.join(root,file))).digest('hex'),digest,`Stale Source evidence: ${file}`)
}
const budgets=values.thresholds?JSON.parse(await readFile(values.thresholds,'utf8')):null
const regions=['frame','surface','text','halo']
if(budgets){
  assert.equal(budgets.component,'action-overflow-menu')
  assert.equal(budgets.platform,process.platform);assert.equal(budgets.scale,1)
  assert(['proposed','reviewed'].includes(budgets.reviewState),'Budget review state is required')
  for(const name of regions)for(const key of ['different','errorSum','maxError'])assert(Number.isFinite(budgets.regions?.[name]?.[key])&&budgets.regions[name][key]>=0,`Missing reviewed ${name}.${key}`)
}
const browser=await chromium.launch({headless:true}),records=[]
try{
  const page=await browser.newPage();await installPngReader(page)
  for(const theme of ['light','dark'])for(const name of ['open','hover','focus']){
    const source=solid.records.find(r=>r.theme===theme&&r.mode===(name==='hover'?'dismiss':'standard'))
    const state=source?.states.find(s=>s.name===name),candidate=native.records.find(r=>r.theme===theme&&r.name===name)
    assert(state&&candidate,`Missing actual pair: ${theme}/${name}`)
    const b=state.geometry.bounds,rect=[b.x,b.y,b.width,b.height]
    assert.deepEqual(candidate.geometry.menu,rect,'Actual menu geometry must match before pixels')
    assert.deepEqual(candidate.geometry.trigger,[state.geometry.trigger.x,state.geometry.trigger.y,state.geometry.trigger.width,state.geometry.trigger.height])
    const rows=state.geometry.rows.filter(row=>row.key!==null)
    for(const guard of state.geometry.rows.filter(row=>row.key===null))assert(guard.bounds.width===1&&guard.bounds.height===1&&!guard.label,'Unexpected unkeyed menu child')
    assert.equal(candidate.geometry.rows.length,rows.length)
    for(const row of rows){
      const found=candidate.geometry.rows.find(item=>item.key===`actions:item:${row.key}`),r=row.bounds
      assert(found,`Missing native row ${row.key}`);assert.deepEqual(found.rect,[r.x,r.y,r.width,r.height])
    }
    const images=await Promise.all([path.join(out,state.file.replace(/\.png$/,'-halo.png')),candidate.image].map(async file=>'data:image/png;base64,'+(await readFile(file)).toString('base64')))
    const measured=await page.evaluate(async({images,geometry})=>{
      const [a,b]=await __codenomadReadPngs(images),clip=geometry.halo,menu=geometry.bounds,trigger=geometry.trigger
      if(a.width!==clip.width||a.height!==clip.height||b.width!==480||b.height!==360)throw Error('Actual scene dimensions differ')
      const within=(x,y,r)=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height
      const rowAt=(x,y)=>geometry.rows.find(row=>within(x,y,row.bounds))
      const textAt=(x,y)=>geometry.rows.some(row=>within(x,y,row.label))
      const region=(x,y)=>{
        if(!within(x,y,menu))return within(x,y,{x:trigger.x-2,y:trigger.y-2,width:trigger.width+4,height:trigger.height+4})?null:'halo'
        if(x<menu.x+1||y<menu.y+1||x>=menu.right-1||y>=menu.bottom-1)return 'frame'
        return textAt(x,y)?'text':'surface'
      }
      const sample=(pixels,x,y)=>pixels.slice((Math.floor(y)*b.width+Math.floor(x))*4,(Math.floor(y)*b.width+Math.floor(x))*4+4)
      const background=sample(b.pixels,0,0),inside=sample(b.pixels,menu.x+2,menu.y+2)
      function measure(pixels){
        const result=Object.fromEntries(['frame','surface','text','halo'].map(name=>[name,{total:0,different:0,errorSum:0,maxError:0}]))
        for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
          const gx=x+clip.x,gy=y+clip.y,name=region(gx,gy);if(!name)continue
          const i=(y*a.width+x)*4,j=(gy*b.width+gx)*4
          let error=0;for(let c=0;c<4;c++)error=Math.max(error,Math.abs(a.pixels[i+c]-pixels[j+c]))
          const r=result[name];r.total++;if(error)r.different++;r.errorSum+=error;r.maxError=Math.max(r.maxError,error)
        }
        return result
      }
      const negatives={}
      for(const fault of ['missing-text','missing-one-label','shift-text-one-pixel','missing-border','missing-highlight','missing-shadow','shift-one-pixel']){
        const pixels=b.pixels.slice()
        for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){
          const name=region(x,y),i=(y*b.width+x)*4,row=rowAt(x,y)
          if(fault==='shift-one-pixel')pixels.set(sample(b.pixels,Math.max(0,x-1),y),i)
          if(fault==='shift-text-one-pixel'&&name==='text')pixels.set(sample(b.pixels,x,Math.max(0,y-1)),i)
          if(fault==='missing-text'&&name==='text'&&row)pixels.set(sample(b.pixels,row.bounds.x+1,row.bounds.y+1),i)
          if(fault==='missing-one-label'&&name==='text'&&row?.key==='open')pixels.set(sample(b.pixels,row.bounds.x+1,row.bounds.y+1),i)
          if(fault==='missing-border'&&name==='frame')pixels.set(inside,i)
          if(fault==='missing-shadow'&&name==='halo')pixels.set(background,i)
          if(fault==='missing-highlight'&&row&&name==='surface')pixels.set(inside,i)
        }
        negatives[fault]=measure(pixels)
      }
      return {regions:measure(b.pixels),negativeControls:negatives}
    },{images,geometry:{...state.geometry,rows}})
    const admitted=measurements=>regions.every(name=>['different','errorSum','maxError'].every(key=>measurements[name][key]<=budgets.regions[name][key]))
    records.push({theme,name,geometry:rect,...measured,pass:budgets?admitted(measured.regions):null,
      negativeControls:Object.fromEntries(Object.entries(measured.negativeControls).map(([fault,metrics])=>[fault,{regions:metrics,rejected:budgets?!admitted(metrics):null}]))})
  }
}finally{await browser.close()}
const pass=budgets&&records.every(record=>record.pass&&Object.values(record.negativeControls).every(control=>control.rejected))
const status=budgets?(pass?`${budgets.reviewState}-budgets-passed`:'failed'):'diagnostic-requires-reviewed-budgets'
await writeFile(path.join(out,'regional-pixels.json'),JSON.stringify({status,budgets,records},null,2)+'\n')
if(budgets)assert(pass,'Actual pixels or deliberate fault rejection failed')
console.log(JSON.stringify({pairs:records.length,status}))
