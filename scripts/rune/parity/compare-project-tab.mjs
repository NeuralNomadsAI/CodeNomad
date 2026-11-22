// Real component pixels; acceptance requires independently reviewed regional budgets.
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {installPngReader} from '../png-pixels.mjs'

const {values}=parseArgs({options:{thresholds:{type:'string'},evidence:{type:'string'}}})
const root=fileURLToPath(new URL('../../../',import.meta.url))
const evidencePath=values.evidence?path.resolve(values.evidence):path.join(root,'target/rune-parity/project-tabs/evidence.json'),out=path.dirname(evidencePath)
const evidence=JSON.parse(await readFile(evidencePath,'utf8'))
const component=evidence.component==='plain-instance-tab'?'instance-tab':'project-tab-alpha'
const theme=JSON.parse(await readFile(path.join(root,'crates/rune-theme-codenomad/assets/theme.json'),'utf8'))
const budgets=values.thresholds?JSON.parse(await readFile(values.thresholds,'utf8')):undefined
if(budgets){
  assert.equal(budgets.platform,process.platform)
  assert.equal(budgets.scale,1)
  assert.equal(budgets.component,component)
  for(const name of ['folder','close','border','body','halo'])for(const key of ['different','errorSum','maxError']){
    assert(Number.isFinite(budgets.regions?.[name]?.[key])&&budgets.regions[name][key]>=0,`Missing reviewed ${name}.${key}`)
  }
}
const browser=await chromium.launch({headless:true}),records=[]
try{
  const page=await browser.newPage();await installPngReader(page)
  for(const record of evidence.records)for(const state of record.states.filter(s=>s.alpha)){
    const alpha=state.alpha;assert(alpha.halo?.rune&&alpha.glyphs,'Run the current actual-component capture fixture first')
    const files=[path.join(out,alpha.file),alpha.rune,path.join(out,alpha.halo.file),alpha.halo.rune]
    const sources=await Promise.all(files.map(async file=>'data:image/png;base64,'+(await readFile(file)).toString('base64')))
    const bounds=alpha.geometry?.bounds??alpha.bounds
    const componentBox=alpha.halo.component??{x:bounds.x-alpha.halo.clip.x,y:bounds.y-alpha.halo.clip.y,width:bounds.width,height:bounds.height}
    const result=await page.evaluate(async({sources,glyphs,borderWidth,componentBox,background})=>{
      const [solid,rune,solidHalo,runeHalo]=await __codenomadReadPngs(sources)
      for(const [a,b] of [[solid,rune],[solidHalo,runeHalo]])if(a.width!==b.width||a.height!==b.height)throw Error('Actual crop dimensions differ')
      const box=(r)=>[Math.floor(r.x),Math.floor(r.y),Math.ceil(r.x+r.width),Math.ceil(r.y+r.height)]
      const boxes=Object.fromEntries(Object.entries(glyphs).map(([key,r])=>[key,box(r)]))
      const component=box(componentBox)
      const inside=(x,y,r)=>x>=r[0]&&y>=r[1]&&x<r[2]&&y<r[3]
      const isBorder=(x,y)=>x<borderWidth||y<borderWidth||x>=solid.width-borderWidth||y>=solid.height-borderWidth
      function measure(a,b,region){
        let different=0,errorSum=0,maxError=0,total=0
        for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
          if(region==='folder'||region==='close'){if(!inside(x,y,boxes[region]))continue}
          else if(region==='border'){if(!isBorder(x,y))continue}
          else if(region==='body'){if(isBorder(x,y)||Object.values(boxes).some(r=>inside(x,y,r)))continue}
          else if(region==='halo'&&inside(x,y,component))continue
          let error=0;for(let c=0;c<4;c++)error=Math.max(error,Math.abs(a.pixels[(y*a.width+x)*4+c]-b.pixels[(y*a.width+x)*4+c]))
          total++;if(error)different++;errorSum+=error;maxError=Math.max(maxError,error)
        }
        return {different,errorSum,maxError,total}
      }
      const regions=['folder','close','border','body']
      const compare=b=>Object.fromEntries(regions.map(name=>[name,measure(solid,b,name)]))
      const negatives={}
      for(const name of ['folder','close']){
        const pixels=rune.pixels.slice(),r=boxes[name],background=pixels.slice((r[1]*rune.width+r[0])*4,(r[1]*rune.width+r[0])*4+4)
        for(let y=r[1];y<r[3];y++)for(let x=r[0];x<r[2];x++)pixels.set(background,(y*rune.width+x)*4)
        negatives[`missing-${name}`]=compare({...rune,pixels})
      }
      const shifted=rune.pixels.slice()
      for(let y=0;y<rune.height;y++)for(let x=0;x<rune.width;x++)for(let c=0;c<4;c++)shifted[(y*rune.width+x)*4+c]=rune.pixels[(y*rune.width+Math.max(0,x-1))*4+c]
      const shiftedHalo=runeHalo.pixels.slice(),noFocus=runeHalo.pixels.slice()
      for(let y=0;y<runeHalo.height;y++)for(let x=0;x<runeHalo.width;x++)for(let c=0;c<4;c++){
        const i=(y*runeHalo.width+x)*4+c
        shiftedHalo[i]=runeHalo.pixels[(y*runeHalo.width+Math.max(0,x-1))*4+c]
        if(!inside(x,y,component))noFocus[i]=background[c]
      }
      negatives['shift-one-pixel']={...compare({...rune,pixels:shifted}),halo:measure(solidHalo,{...runeHalo,pixels:shiftedHalo},'halo')}
      return {regions:compare(rune),negativeControls:negatives,halo:measure(solidHalo,runeHalo,'halo'),missingFocus:measure(solidHalo,{...runeHalo,pixels:noFocus},'halo'),neighborhood:measure(solidHalo,runeHalo,'all'),glyphBoxes:boxes,componentBox:component}
    },{sources,glyphs:alpha.glyphs,borderWidth:theme.metrics[record.theme].tabActive.borderTopWidth,componentBox,background:theme[record.theme]['surface-secondary'].slice(1).match(/../g).map(h=>parseInt(h,16))})
    if(state.state==='focus')result.negativeControls['missing-focus']={halo:result.missingFocus}
    const admitted=regions=>Object.entries(regions).every(([name,m])=>['different','errorSum','maxError'].every(k=>m[k]<=budgets.regions[name][k]))
    const actual=budgets?admitted({...result.regions,halo:result.halo}):null
    const negatives=Object.fromEntries(Object.entries(result.negativeControls).map(([name,regions])=>[name,{regions,rejected:budgets?!admitted(regions):null}]))
    records.push({id:record.id,state:state.state,...result,negativeControls:negatives,pass:actual,
      haloProvenance:alpha.halo.provenance})
  }
}finally{await browser.close()}
const pass=budgets&&records.every(r=>r.pass&&Object.values(r.negativeControls).every(n=>n.rejected))
await writeFile(path.join(out,'regional-pixels.json'),JSON.stringify({
  status:budgets?(pass?'reviewed-budgets-and-negative-controls-passed':'failed'):'diagnostic-requires-reviewed-regional-budgets',
  method:'Exact maximum RGBA channel error; SVG regions from actual Solid DOM rectangles; full source neighborhood retained',
  component,wholeInstanceTabs:'pending',budgets,records,
},null,2)+'\n')
if(budgets)assert(pass,'Actual regional comparison or deliberate rendering-fault rejection failed')
console.log(JSON.stringify({pairs:records.length,status:budgets?(pass?'passed':'failed'):'diagnostic-only'}))
