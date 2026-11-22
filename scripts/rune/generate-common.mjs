import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
export const themeRoot=path.join(root,'crates/rune-theme-codenomad')
export const check=process.argv.includes('--check')
export const slash=value=>value.replaceAll(path.sep,'/')
export async function sources(files){
  const out={}
  for(const file of [...new Set(files)].sort())out[slash(path.relative(root,file))]=createHash('sha256').update((await readFile(file,'utf8')).replaceAll('\r\n','\n')).digest('hex')
  return out
}
export function sorted(value){
  if(Array.isArray(value))return value.map(sorted)
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])]))
  return value
}
export async function generated(relative,value){
  const target=path.join(themeRoot,relative),text=typeof value==='string'?value:JSON.stringify(sorted(value),null,2)+'\n'
  if(check){assert.equal((await readFile(target,'utf8')).replaceAll('\r\n','\n'),text.replaceAll('\r\n','\n'),`${slash(path.relative(root,target))} is stale; run its generator`)}
  else {await mkdir(path.dirname(target),{recursive:true});await writeFile(target,text)}
  console.log(`${check?'verified':'generated'} ${slash(path.relative(root,target))}`)
}
