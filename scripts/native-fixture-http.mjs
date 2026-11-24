import assert from 'node:assert/strict'
import {existsSync,realpathSync} from 'node:fs'
import {Agent as HttpAgent} from 'node:http'
import {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot=path.resolve(fileURLToPath(new URL('..',import.meta.url)))
const worktreeNodeModules=path.join(repoRoot,'node_modules')
const requireLocal=createRequire(import.meta.url)

function packageNameOf(specifier){
  const parts=specifier.split('/')
  return specifier.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
}

export function resolveWorktreePackage(specifier,nodeModulesDir=worktreeNodeModules){
  assert(existsSync(nodeModulesDir),'Worktree node_modules is required; parent checkout dependencies are forbidden')
  const pkg=packageNameOf(specifier)
  const pkgDir=path.join(nodeModulesDir,...pkg.split('/'))
  assert(existsSync(path.join(pkgDir,'package.json')),
    `Worktree node_modules is missing ${pkg}; parent checkout dependencies are forbidden`)
  return requireLocal.resolve(specifier,{paths:[nodeModulesDir]})
}

const isUnc=value=>typeof value==='string'&&(/^[\\/]{2}/.test(value)||/^[\\/]{2}/.test(path.normalize(value)))
export const isLocalAbsolutePath=value=>typeof value==='string'&&value.length>0&&path.isAbsolute(value)&&!isUnc(value)

export function resolveLocalExecutable(raw,label='executable'){
  assert(isLocalAbsolutePath(raw),`Pass an absolute local ${label}`)
  const resolved=realpathSync(raw)
  assert(isLocalAbsolutePath(resolved),`Resolved ${label} must stay on a local filesystem`)
  return resolved
}

export function redactSecrets(text,secrets=[]){
  let value=String(text??'')
  for(const secret of secrets){
    if(!secret)continue
    for(const token of [secret,Buffer.from(`opencode:${secret}`).toString('base64'),Buffer.from(`codenomad:${secret}`).toString('base64')]){
      value=value.replaceAll(token,'<fixture password>')
    }
  }
  return value
}

const {Agent,fetch:undiciFetch}=requireLocal(resolveWorktreePackage('undici'))

const dispatcher=new Agent()
export const fixtureHttpAgent=new HttpAgent({keepAlive:true,proxyEnv:{}})

export function withoutFixtureProxy(env){
  return Object.fromEntries(Object.entries(env).filter(([key])=>
    !/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)))
}

export function fixtureTarget(raw,origin){
  try{
    const base=new URL(origin),target=new URL(raw,base)
    if(['http:','https:'].includes(base.protocol)&&target.protocol===base.protocol&&
      target.origin===base.origin&&!target.username&&!target.password&&!target.hash)return target
  }catch{}
  return null
}

export function relayTarget(req,res,origin){
  const target=fixtureTarget(req.url,origin)
  if(!target){res.writeHead(403);res.end('Foreign fixture origin or protocol forbidden')}
  return target
}

// Use our own dispatcher: neither Node's global fetch nor environment proxy rules apply.
export function fixtureFetch(input,init={}){
  if(input instanceof Request){
    const {url,method,headers,body,signal}=input
    return fixtureFetch(url,{method,headers,body,signal,...init})
  }
  return undiciFetch(input,{...init,duplex:'half',dispatcher,redirect:'error'})
}
