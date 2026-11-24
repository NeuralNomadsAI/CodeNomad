import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {Agent as HttpAgent} from 'node:http'
import {Agent,fetch as undiciFetch} from 'undici'

assert(existsSync(new URL('../node_modules',import.meta.url)),'Worktree node_modules is required; parent checkout dependencies are forbidden')

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
