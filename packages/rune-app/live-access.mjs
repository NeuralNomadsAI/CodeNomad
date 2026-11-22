import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const cli='C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe'
export async function connectNative() {
  const exec=promisify(execFile)
  const call=async(...args)=>(await exec(cli,args,{windowsHide:true,timeout:15000})).stdout.trim()
  const origin=await call('service','status')
  const endpoint=new URL(origin)
  if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:')throw Error('Expected the existing loopback OpenCode service')
  const password=await call('service','get','password')
  if(!password)throw Error('OpenCode service credential unavailable')
  const read=async(route,init={})=>{
    const response=await fetch(new URL(route,endpoint),{...init,headers:{authorization:`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      'content-type':'application/json',...init.headers},signal:AbortSignal.timeout(30000)})
    const body=await response.json().catch(()=>({}))
    if(!response.ok)throw Error(`OpenCode ${route.split('?')[0]}: HTTP ${response.status}`)
    return body
  }
  return {origin:endpoint.href,password,read}
}
