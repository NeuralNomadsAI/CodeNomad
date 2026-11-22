// Strict Windows raster qualification, including deliberate rendering faults.
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {installPngReader} from '../png-pixels.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url))
const out=path.join(root,'target/rune-parity/window-close')
const evidence=JSON.parse(await readFile(path.join(out,'evidence.json'),'utf8'))
const thresholds=JSON.parse(await readFile(new URL('./window-close-thresholds.json',import.meta.url),'utf8'))
assert.equal(process.platform,thresholds.platform,'This raster threshold qualifies Windows only')
const admitted=m=>m.maxError<=thresholds.maxChannelError && m.totalMaxChannelError<=thresholds.maxTotalChannelError &&
  m.different<=thresholds.maxDifferentPixels && m.exteriorDifferent<=thresholds.maxExteriorDifferentPixels
const browser=await chromium.launch({headless:true})
const records=[]
try {
  const page=await browser.newPage()
  await installPngReader(page)
  for(const record of evidence.records) {
    assert(record.rune,'Execute the native capture before comparing')
    const sources=await Promise.all([record.solid,record.rune].map(async f=>
      'data:image/png;base64,'+(await readFile(f)).toString('base64')))
    const metrics=await page.evaluate(async sources=>{
      const images=await globalThis.__codenomadReadPngs(sources)
      const [a,b]=images
      if(a.width!==b.width||a.height!==b.height)throw Error('Crop dimensions differ')
      const c={width:a.width,height:a.height}
      const pixels=images.map(image=>image.pixels)
      function measure(reference,target){
      let different=0,totalError=0,maxError=0,exteriorDifferent=0
      const errors=[]
      for(let i=0;i<reference.length;i+=4){
        const x=i/4%c.width,y=Math.floor(i/4/c.width)
        const error=Math.max(...[0,1,2,3].map(k=>Math.abs(reference[i+k]-target[i+k])))
        totalError+=error;maxError=Math.max(maxError,error)
        if(error){different++;errors.push({x,y,error});if(x<5||x>=19||y<5||y>=19)exteriorDifferent++}
      }
      return {width:c.width,height:c.height,different,total:c.width*c.height,
        diffRatio:different/(c.width*c.height),totalMaxChannelError:totalError,meanMaxChannelError:totalError/(c.width*c.height),maxError,
        exteriorDifferent,errors}
      }
      const erased=pixels[1].slice(),shifted=pixels[1].slice()
      const background=(2*c.width+2)*4
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)for(let k=0;k<4;k++){
        const i=(y*c.width+x)*4+k
        if(x>=5&&x<19&&y>=5&&y<19)erased[i]=pixels[1][background+k]
        shifted[i]=x?pixels[1][i-4]:pixels[1][background+k]
      }
      return {...measure(...pixels),negativeControls:{missingGlyph:measure(pixels[0],erased),shiftedOnePixel:measure(pixels[0],shifted)}}
    },sources)
    const {negativeControls,...actual}=metrics
    const negatives=Object.fromEntries(Object.entries(negativeControls).map(([name,m])=>[name,{...m,rejected:!admitted(m)}]))
    records.push({theme:record.theme,state:record.state,...actual,pass:admitted(actual),negativeControls:negatives})
  }
}finally{await browser.close()}
const pass=records.every(r=>r.pass&&Object.values(r.negativeControls).every(n=>n.rejected))
await writeFile(path.join(out,'pixel-measurements.json'),JSON.stringify({
  status:pass?'passed-windows-scale-1':'failed',method:'RGBA maximum channel absolute error per pixel',thresholds,records
},null,2))
assert(pass,'Actual parity or deliberate rendering fault rejection failed')
console.log(records.map(({errors,negativeControls,...r})=>({...r,negativeControls:Object.keys(negativeControls)})))
