import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {installPngReader} from '../png-pixels.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url))
const solid=JSON.parse(await readFile(path.join(root,'target/rune-parity/file-row-actions/solid-evidence.json'),'utf8'))
const native=JSON.parse(await readFile(path.join(root,'target/rune-parity/file-row-actions-native/native-evidence.json'),'utf8'))
const browser=await chromium.launch({headless:true}),page=await browser.newPage(),records=[]
try{
  await installPngReader(page)
  for(const n of native.records){
    const source=solid.records.find(s=>s.id===`${n.theme}-${n.rtl?'rtl':'ltr'}`)?.states.find(s=>s.name===n.mode)
    assert(source,`Missing actual Source capture ${n.id}`)
    const s=source.geometry,group=n.geometry.find(e=>e.key==='files:actions')
    const relative=r=>[r.x-s.row.x,r.y-s.row.y,r.width,r.height]
    assert.deepEqual(group.rect,relative(s.actions),`${n.id}: actual action group geometry`)
    const buttons=s.buttons.filter(b=>b.display!=='none'&&b.visibility==='visible'&&b.rect.width>0).map(b=>({name:b.name,rect:relative(b.rect),glyph:relative(b.glyph)}))
    for(const b of buttons){
      const key=b.name==='Actions'?'files:trigger':b.name==='Preview'?'files:pinned:preview':`files:inline:${b.name.toLowerCase()}`
      assert.deepEqual(n.geometry.find(e=>e.key===key)?.rect,b.rect,`${n.id}/${b.name}: actual button geometry`)
    }
    const images=await Promise.all([source.image,n.image].map(async image=>'data:image/png;base64,'+(await readFile(image)).toString('base64')))
    const regions=await page.evaluate(async({images,buttons,group})=>{
      const [s,n]=await globalThis.__codenomadReadPngs(images)
      const results={}
      const measure=(name,rect,mask)=>{
        let different=0,errorSum=0,maxError=0,pixels=0
        for(let y=Math.floor(rect[1]);y<Math.ceil(rect[1]+rect[3]);y++)for(let x=Math.floor(rect[0]);x<Math.ceil(rect[0]+rect[2]);x++){
          if(!mask(x,y))continue
          let changed=false;pixels++
          for(let c=0;c<4;c++){const delta=Math.abs(s.pixels[(y*s.width+x)*4+c]-n.pixels[(y*n.width+x)*4+c]);changed||=delta!==0;errorSum+=delta;maxError=Math.max(maxError,delta)}
          different+=Number(changed)
        }
        results[name]={pixels,different,errorSum,maxError}
      }
      const inside=(x,y,r)=>x>=r[0]&&y>=r[1]&&x<r[0]+r[2]&&y<r[1]+r[3]
      for(const b of buttons){
        const r=b.rect,glyph=b.glyph
        measure(b.name+'/glyph',r,(x,y)=>inside(x,y,glyph))
        measure(b.name+'/border',r,(x,y)=>x===r[0]||x===r[0]+r[2]-1||y===r[1]||y===r[1]+r[3]-1)
        measure(b.name+'/surface',r,(x,y)=>!inside(x,y,glyph)&&x>r[0]&&x<r[0]+r[2]-1&&y>r[1]&&y<r[1]+r[3]-1)
      }
      measure('gaps',group,(x,y)=>!buttons.some(b=>inside(x,y,b.rect)))
      return results
    },{images,buttons,group:group.rect})
    records.push({id:n.id,regions})
  }
}finally{await browser.close()}
const report={status:'measurements-only',adopted:false,scope:'Actual visible action group and buttons; 14px glyph, one-pixel border, surface and gaps measured separately',records}
await writeFile(path.join(root,'target/rune-parity/file-row-actions-native/measurements.json'),JSON.stringify(report,null,2)+'\n')
for(const r of records)console.log(r.id,JSON.stringify(Object.fromEntries(Object.entries(r.regions).filter(([,v])=>v.different))))
