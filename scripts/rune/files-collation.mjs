// Headless qualification of the actual Rust/WASM Files collator; product sources stay untouched.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawnFixtureChild as spawn} from '../native-fixture-guards.mjs'
import {createServer} from 'node:http'
import {copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'

const root=fileURLToPath(new URL('../../',import.meta.url))
const {values}=parseArgs({options:{bindgen:{type:'string'},out:{type:'string'}}})
const target=process.env.CARGO_TARGET_DIR
assert(target&&path.isAbsolute(target),'Set CARGO_TARGET_DIR to an existing absolute build cache')
assert((await stat(target)).isDirectory(),'CARGO_TARGET_DIR must already exist')
assert(values.bindgen&&path.isAbsolute(values.bindgen),'--bindgen must name an installed absolute wasm-bindgen executable')
assert((await stat(values.bindgen)).isFile(),'wasm-bindgen must already exist')
const ownedRoot=path.join(root,'target')
await mkdir(ownedRoot,{recursive:true})
let out
if(values.out){
  assert(path.isAbsolute(values.out),'--out must be absolute')
  const relative=path.relative(ownedRoot,values.out)
  assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'--out must be a new directory under this worktree target')
  const parent=await realpath(path.dirname(values.out)),base=await realpath(ownedRoot)
  assert(parent===base||parent.startsWith(base+path.sep),'--out parent must stay inside target')
  await mkdir(values.out);out=values.out
}else out=await mkdtemp(path.join(ownedRoot,'rune-files-collation-'))
const bundle=path.join(out,'bundle'),probe=path.join(root,'packages/rune-app/tests/probes/collation_web.rs')
await mkdir(bundle)
await writeFile(path.join(out,'owner.json'),JSON.stringify({runner:fileURLToPath(import.meta.url),target},null,2))
async function run(command,args,label){
  let stdout='',tail='',log=''
  const started=Date.now()
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,windowsHide:true,env:{...process.env,CARGO_INCREMENTAL:'0'}})
    const timer=setTimeout(()=>{child.kill();reject(new Error(`${label} timed out`))},180000)
    const consume=chunk=>{tail=(tail+chunk).slice(-16000);if(log.length<524288)log=(log+chunk).slice(0,524288)}
    child.stdout.on('data',chunk=>{stdout+=chunk;consume(chunk)});child.stderr.on('data',consume)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`${label} exited ${code}:\n${tail}`))})
  }).finally(()=>writeFile(path.join(out,`${label}.log`),log))
  return {milliseconds:Date.now()-started,stdout,tail}
}
const lock=await readFile(path.join(root,'Cargo.lock'),'utf8')
const version=name=>{const match=lock.match(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`));assert(match,`${name} missing in lock`);return match[1]}
const bindgenVersion=version('wasm-bindgen')
const bindgen=await run(values.bindgen,['--version'],'bindgen-version')
assert(bindgen.stdout.trim()===`wasm-bindgen ${bindgenVersion}`,'Installed bindgen must match Cargo.lock')
const quote=value=>JSON.stringify(value.replaceAll('\\','/'))
await writeFile(path.join(out,'Cargo.toml'),`[package]
name = "rune-files-collation-probe"
version = "0.0.0"
edition = "2024"
[lib]
path = ${quote(probe)}
crate-type = ["cdylib"]
[workspace]
[dependencies]
codenomad-client = { path = ${quote(path.join(root,'crates/codenomad-client'))} }
serde_json = "1"
js-sys = "=${version('js-sys')}"
wasm-bindgen = "=${bindgenVersion}"
[profile.dev]
debug = 0
`)
await copyFile(path.join(root,'Cargo.lock'),path.join(out,'Cargo.lock'))
const cargo=['+1.99.1','build','--offline','--manifest-path',path.join(out,'Cargo.toml'),'--target','wasm32-unknown-unknown']
const first=await run('cargo',cargo,'cargo-offline')
const locked=await run('cargo',[...cargo,'--locked'],'cargo-locked')
await run(values.bindgen,[path.join(target,'wasm32-unknown-unknown/debug/rune_files_collation_probe.wasm'),'--target','web','--out-dir',bundle,'--out-name','app'],'bindgen')
const csp="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"
const server=createServer(async(request,response)=>{
  response.setHeader('content-security-policy',csp)
  try{
    const pathname=new URL(request.url,'http://localhost').pathname
    if(pathname==='/'){response.setHeader('content-type','text/html');response.end('<html lang="fr"><script type="module" src="/boot.js"></script></html>');return}
    if(pathname==='/boot.js'){response.setHeader('content-type','text/javascript');response.end('import init,{sort_files} from "/app.js";await init();globalThis.sortFiles=sort_files;globalThis.ready=true');return}
    const file=path.resolve(bundle,`.${decodeURIComponent(pathname)}`)
    assert(file.startsWith(bundle+path.sep))
    response.setHeader('content-type',file.endsWith('.wasm')?'application/wasm':'text/javascript');response.end(await readFile(file))
  }catch{response.statusCode=404;response.end('missing')}
})
let browser
const records=[],cases=[]
const names=['file2','file10','a','A','ä','z','å','ö','é','e\u0301','I','ı','İ','i','_a','-a','Ａ','a-b','ab','😀','🦀']
const rows=names.map((name,index)=>[name,index%3===0,`entry-${index}`])
rows.push(['é',false,'equal-first'],['e\u0301',false,'equal-second'])
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex')
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const origin=`http://127.0.0.1:${server.address().port}`
  browser=await chromium.launch({headless:true})
  for(const locale of [undefined,'en-US','fr-FR','sv-SE','tr-TR','de-DE']){
    const context=await browser.newContext(locale?{locale}:{})
    try{
      const page=await context.newPage(),record={locale:locale??'default',errors:[]};records.push(record)
      page.on('pageerror',error=>record.errors.push(error.message.slice(0,2000)))
      await page.route('**/*',route=>{assert.equal(new URL(route.request().url()).origin,origin);return route.continue()})
      const response=await page.goto(origin);assert.equal(response.headers()['content-security-policy'],csp)
      await page.waitForFunction(()=>globalThis.ready)
      const result=await page.evaluate(({rows,names})=>{
        const collator=new Intl.Collator()
        const expected=rows.slice().sort((a,b)=>Number(b[1])-Number(a[1])||a[0].localeCompare(b[0])).map(row=>row[2])
        const matrixSigns=names.map(a=>names.map(b=>Math.sign(a.localeCompare(b))))
        return {expected,actual:JSON.parse(sortFiles(JSON.stringify(rows))),uiLocale:document.documentElement.lang,
          matrix:{navigatorLanguage:navigator.language,resolved:collator.resolvedOptions(),names,matrixSigns}}
      },{rows,names})
      cases.push(result.matrix);delete result.matrix;Object.assign(record,result)
      assert.deepEqual(record.actual.paths,record.expected);assert.equal(record.uiLocale,'fr')
      assert.equal(record.actual.locale,cases.at(-1).resolved.locale)
      record.failures=await page.evaluate(rows=>{
        const observe=()=>{try{sortFiles(JSON.stringify(rows));return {rejected:false}}catch(error){return {rejected:true,message:String(error),runtimePanic:error instanceof WebAssembly.RuntimeError}}}
        const intl=globalThis.Intl,original=intl.Collator,sort=Array.prototype.sort,failures=[]
        try{
          globalThis.Intl=undefined;failures.push({case:'missing-Intl',...observe()});globalThis.Intl=intl
          Intl.Collator=function(){throw Error('synthetic constructor failure')};failures.push({case:'constructor',...observe()})
          Intl.Collator=function(){return {compare:()=>NaN,resolvedOptions:()=>({locale:'en-US'})}};failures.push({case:'NaN',...observe()})
          Intl.Collator=original
          Array.prototype.sort=function(){throw Error('synthetic sort failure')};failures.push({case:'sort-throws',...observe()})
          Array.prototype.sort=function(){this[1]=this[0];return this};failures.push({case:'duplicate-index',...observe()})
        }finally{globalThis.Intl=intl;intl.Collator=original;Array.prototype.sort=sort}
        return failures
      },rows)
      assert.equal(record.failures.length,5);assert(record.failures.every(f=>f.rejected&&!f.runtimePanic))
      assert.deepEqual(record.errors,[]);record.pass=true
    }finally{await context.close()}
  }
}finally{
  const browserVersion=browser?.version()
  await browser?.close()
  if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})
  await writeFile(path.join(out,'js-proof.json'),JSON.stringify({browserVersion,cases},null,2))
  await writeFile(path.join(out,'proof.json'),JSON.stringify({browser:browserVersion,csp,rows,bindgenVersion,
    builds:{offlineMs:first.milliseconds,lockedMs:locked.milliseconds},
    provenance:{driver:await hash(fileURLToPath(import.meta.url)),rust:await hash(probe),adapter:await hash(path.join(root,'packages/rune-app/src/platform/collation.rs')),wasm:await hash(path.join(bundle,'app_bg.wasm'))},records},null,2))
}
console.log(JSON.stringify({pass:true,contexts:records.length,safeFailures:records.reduce((sum,record)=>sum+record.failures.length,0),out}))
