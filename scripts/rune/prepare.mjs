// Fetch only the explicitly pinned Rune source. Compilation belongs to the caller's target cache.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {access,readFile,mkdir} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('../../',import.meta.url))
const manifest=await readFile(path.join(root,'packages/rune-app/Cargo.toml'),'utf8')
const metadata=manifest.split('[package.metadata.rune]')[1]?.split('\n[')[0]
const revision=metadata?.match(/^rev\s*=\s*"([a-f0-9]{40})"/m)?.[1]
assert(revision,'Rune revision must be explicitly pinned in the application manifest')
const checkout=path.join(root,'.prototype-deps/rune')
async function git(args){
  return await new Promise((resolve,reject)=>{
    const child=spawn('git',args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr=''
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024)child.kill()})
    child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>1024*1024)child.kill()})
    child.once('error',reject)
    child.once('exit',code=>code===0?resolve(stdout.trim()):reject(new Error(`Git source preparation failed (${code}): ${stderr.slice(-2048)}`)))
  })
}
let exists=true;try{await access(checkout)}catch(error){if(error.code!=='ENOENT')throw error;exists=false}
if(!exists){
  assert(!process.argv.includes('--check'),'Pinned Rune source is missing; run preparation first')
  await mkdir(path.dirname(checkout),{recursive:true})
  await git(['clone','--no-checkout','https://github.com/anomalyco/rune.git',checkout])
  await git(['-C',checkout,'checkout','--detach',revision])
}
assert.equal(await git(['-C',checkout,'rev-parse','HEAD']),revision,'Unexpected Rune revision')
assert.equal(await git(['-C',checkout,'status','--porcelain']),'','Rune dependency checkout must be clean')
console.log(JSON.stringify({source:'anomalyco/rune',revision,verified:true}))
