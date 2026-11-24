import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import path from 'node:path'
import {chromium} from 'playwright'
import {runeSource} from '../../../scripts/rune/source.mjs'

const bundle=process.argv[2]
assert(bundle&&path.isAbsolute(bundle),'Pass the absolute wasm-bindgen output directory')
const assets=new Map(await Promise.all([
  ['rail.js','application/javascript'],['rail_bg.wasm','application/wasm'],
].map(async ([name,type])=>['/'+name,[type,await readFile(path.join(bundle,name))]])))
const fontDir=path.join(runeSource(),'assets/web')
for(const name of ['Inter-Regular.ttf','Inter-Medium.ttf','Inter-SemiBold.ttf']){
  assets.set('/'+name,['font/ttf',await readFile(path.join(fontDir,name))])
}
for(const file of await readdir(path.join(bundle,'snippets'),{recursive:true,withFileTypes:true})){
  if(!file.isFile()||!file.name.endsWith('.js'))continue
  const source=path.join(file.parentPath,file.name)
  assets.set('/'+path.relative(bundle,source).replaceAll(path.sep,'/'),['application/javascript',await readFile(source)])
}
const server=createServer((req,res)=>{
  if(req.url==='/'){
    res.writeHead(200,{'Content-Type':'text/html'}).end(`<!doctype html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <script type="module">import init from '/rail.js'; await init()</script>`)
  }else if(assets.has(req.url)){
    const [type,body]=assets.get(req.url)
    res.writeHead(200,{'Content-Type':type}).end(body)
  }else if(req.url==='/favicon.ico')res.writeHead(204).end()
  else res.writeHead(404).end()
})
await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve))
let browser
try{
  browser=await chromium.launch({executablePath:process.env.CODENOMAD_BROWSER_PATH,
    args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
  for(const colorScheme of ['light','dark']){
    const page=await browser.newPage({viewport:{width:420,height:320},colorScheme})
    page.on('pageerror',error=>console.error(error.message))
    page.on('console',message=>{if(message.type()==='error')console.error(message.text())})
    page.on('response',response=>{if(response.status()>=400)console.error(response.status(),response.url())})
    const rail=page.getByRole('navigation',{name:'Message timeline'})
    const first=rail.getByRole('button',{name:'Message 00000',exact:true})
    const last=rail.getByRole('button',{name:'Message 199999',exact:true})
    const selection=id=>page.getByText(`Selection: Message ${id}`,{exact:true})
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    try{await first.waitFor({timeout:30_000})}catch(error){
      console.error(await page.locator('body').ariaSnapshot())
      throw error
    }
    assert(!await last.count()||(await last.boundingBox()).y>=320,'A distant marker must be outside the clip')
    const mounted=async()=>rail.locator('button').count()
    assert((await mounted())<256,'The accessibility mirror must remain bounded')
    const box=await first.boundingBox()
    assert(box.width<=40&&box.width>20&&box.height===20)
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2)
    await selection('00000').waitFor()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await selection('00001').waitFor()
    await page.getByRole('button',{name:'Reveal last marker'}).click({force:true})
    await last.waitFor()
    assert.equal(await first.count(),0,'Revealing a distant marker must release the old end')
    assert((await mounted())<256)
    const end=await last.boundingBox()
    await page.mouse.click(end.x+end.width/2,end.y+end.height/2)
    await selection('199999').waitFor()
    await page.screenshot({path:path.join(bundle,`rail-${colorScheme}.png`)})
    await page.setViewportSize({width:419,height:320})
    await rail.waitFor({state:'detached'})
    await page.close()
  }
  console.log('Chromium: 200,000 markers, bounded mount, pointer and keyboard selection, distant reveal, 420px breakpoint.')
}finally{
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
}
