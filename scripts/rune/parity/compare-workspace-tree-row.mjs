import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {installPngReader} from '../png-pixels.mjs'
import {measureWorkspaceRow} from './workspace-tree-row-pixels.mjs'
import {contextInputs} from './source-context.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=path.join(root,'target/rune-source-theme-context/parity/workspace-tree-row')
const {values}=parseArgs({options:{thresholds:{type:'string'}}})
const thresholdPath=values.thresholds||fileURLToPath(new URL('./workspace-tree-row-thresholds.json',import.meta.url))
const thresholds=JSON.parse(await readFile(thresholdPath,'utf8'))
assert.equal(thresholds.component,'workspace-tree-row');assert.equal(thresholds.platform,process.platform)
assert.equal(thresholds.scale,1);assert.equal(thresholds.width,360)
assert(['proposed','reviewed'].includes(thresholds.reviewState),'Thresholds require an explicit review state')
const adopted=thresholds.reviewState==='reviewed'&&thresholds.sourceContext==='product-default'
const fields=['different','errorSum','maxError']
const budget=(key,source)=>{
  const found=thresholds.regions[key]?.find(rule=>Object.entries(rule.when||{}).every(([k,v])=>Array.isArray(v)?v.includes(source[k]):v===source[k]))
  assert(found,`Missing threshold: ${key}/${source.id}`)
  for(const field of fields)assert(Number.isFinite(found[field])&&found[field]>=0,`Invalid ${key}.${field}`)
  return Object.fromEntries(fields.map(field=>[field,found[field]]))
}
const failures=(measured,limit)=>fields.filter(field=>measured[field]>limit[field])
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const solid=JSON.parse(await readFile(path.join(out,'solid-evidence.json'),'utf8'))
const native=JSON.parse(await readFile(path.join(out,'native-evidence.json'),'utf8'))
assert.equal(solid.records.length,20);assert.equal(native.records.length,20)
const expected=['light','dark'].flatMap(theme=>['ltr','rtl'].flatMap(dir=>['closed','open','file','busy','focus'].map(mode=>`${theme}-${dir}-${mode}`))).sort()
for(const evidence of [solid,native])assert.deepEqual(evidence.records.map(r=>r.id).sort(),expected,'The complete twenty-case matrix must be unique')
for(const [file,digest] of Object.entries(solid.provenance)){
  const bytes=await readFile(path.join(root,file))
  assert.equal(hash(contextInputs.includes(file)?bytes.toString('utf8').replaceAll('\r\n','\n'):bytes),digest,file)
}
assert.equal(hash(await readFile(native.provenance.binary.path)),native.provenance.binary.sha256)
for(const [file,digest] of Object.entries(native.provenance.inputs))assert.equal(hash(await readFile(path.join(root,file))),digest,`Stale native source ${file}`)
const provenance={source:solid.provenance,native:native.provenance,thresholds:{path:thresholdPath,sha256:hash(await readFile(thresholdPath))},scripts:{}}
for(const name of ['compare-workspace-tree-row.mjs','workspace-tree-row-pixels.mjs'])provenance.scripts[name]=hash(await readFile(new URL(name,import.meta.url)))
const browser=await chromium.launch({headless:true}),records=[],geometryFailures=[]
try{
  const page=await browser.newPage();await installPngReader(page)
  for(const source of solid.records){
    const candidate=native.records.find(r=>r.id===source.id);assert(candidate)
    assert.equal(source.caller?.platform,process.platform);assert.equal(candidate.caller?.platform,process.platform)
    assert.equal(source.caller.host,'desktop-local');assert.equal(candidate.caller.host,'desktop-local')
    assert.deepEqual(candidate.caller.actions,source.caller.actions);assert.equal(candidate.caller.canOpen,source.caller.canOpen)
    const [rx,ry]=[source.geometry.row.x,source.geometry.row.y]
    const boxes=source.geometry.children.map(c=>[c.rect.x-rx,c.rect.y-ry,c.rect.width,c.rect.height])
    const find=key=>candidate.geometry.find(e=>e.key===key).rect
    const geometry={row:[0,0,360,30],icon:boxes[1],label:boxes[2]}
    if(source.mode!=='file')geometry.chevron=boxes[0]
    for(const [key,expected] of Object.entries(geometry))if(JSON.stringify(find(key))!==JSON.stringify(expected))geometryFailures.push({id:source.id,key,expected,actual:find(key)})
    const donor=native.records.find(r=>r.theme===source.theme&&!r.rtl&&r.mode===(source.mode==='file'?'closed':'file'))
    const unselected=native.records.find(r=>r.theme===source.theme&&r.rtl===source.rtl&&r.mode==='closed')
    const images=await Promise.all([path.join(out,`solid-${source.id}.png`),candidate.image,donor.image,unselected.image].map(async p=>'data:image/png;base64,'+(await readFile(p)).toString('base64')))
    const measured=await page.evaluate(measureWorkspaceRow,{images,boxes,mode:source.mode})
    assert.equal(measured.regionPixels,measured.totalPixels,'Every pixel must be assigned, with no omitted area')
    const regions=Object.fromEntries(Object.entries(measured.regions).map(([key,value])=>{
      const limit=budget(key,source);return [key,{...value,limit,failures:failures(value,limit)}]
    }))
    const controls=measured.controls.map(control=>({...control,failures:failures(control.measured,budget(control.region,source))}))
    records.push({id:source.id,geometry:geometryFailures.some(f=>f.id===source.id)?'failed':'matched',regions,controls,exclusions:measured.exclusions})
  }
}finally{await browser.close()}
const baselineFailures=records.flatMap(r=>Object.entries(r.regions).filter(([,v])=>v.failures.length).map(([region,v])=>({id:r.id,region,failures:v.failures})))
const undetectedControls=records.flatMap(r=>r.controls.filter(c=>!c.failures.length||!c.changedPixels).map(c=>({id:r.id,name:c.name,region:c.region,changed:c.changedPixels,measured:c.measured})))
const report={status:geometryFailures.length||baselineFailures.length||undetectedControls.length?'failed':adopted?'reviewed-thresholds-passed':'product-context-review-required',adopted,sourceContext:'product-default',provenance,geometryFailures,baselineFailures,undetectedControls,records,
  limits:['Thresholds cover the twenty recorded Windows scale-one 360px cases.','Caller-supplied actions are evaluated as this gallery assembly; animation thresholds concern recorded frames only.','Native AccessKit is verified; DOM treeitem nesting/level, pointer-focus-within and motion remain unqualified.']}
await writeFile(path.join(out,'comparison.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({pairs:records.length,controls:records.reduce((n,r)=>n+r.controls.length,0),geometryFailures,baselineFailures,undetectedControls},null,2))
assert.deepEqual(geometryFailures,[],'Candidate geometry differs from product-default Source')
assert.deepEqual(baselineFailures,[],'Candidate exceeds regional thresholds')
assert.deepEqual(undetectedControls,[],'Each applicable negative mutation must fail its own regional threshold')
assert(adopted,'Product-default context requires independently reviewed thresholds for that context')
