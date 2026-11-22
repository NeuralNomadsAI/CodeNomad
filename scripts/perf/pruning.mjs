// Provision only the owned Rune benchmark daemon, using the production installer and RPC contract.
import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {OpenCode} from '@opencode/client'
import {tsImport} from 'tsx/esm/api'
import {nativePluginBuild} from '../../packages/server/scripts/native-plugin-build.mjs'
import {privatePath} from './isolation.mjs'

export async function preparePruning(root, config) {
  root=privatePath(root);config=privatePath(config)
  const folder=privatePath(path.join(root,'pruning-build'))
  await mkdir(folder,{recursive:true})
  const outfile=path.join(folder,'plugin.mjs')
  await build({...nativePluginBuild,
    entryPoints:[fileURLToPath(new URL('../../packages/server/src/opencode/session-pruning/desktop-plugin.ts',import.meta.url))],outfile,
    banner:{js:'// CodeNomad plugin IDs: ["codenomad-session-pruning"]\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'},
  })
  const [{installPruningPresence},{awaitNativePlugin},{navigationWindowResultSchema}]=await Promise.all([
    tsImport('../../packages/server/src/opencode/pruning-installation.ts',import.meta.url),
    tsImport('../../packages/server/src/opencode/plugin-activation.ts',import.meta.url),
    tsImport('../../packages/server/src/opencode/session-pruning/navigation-contract.ts',import.meta.url),
  ])
  const bundle=await readFile(outfile)
  const presence=await installPruningPresence(bundle,{config,data:privatePath(path.join(root,'pruning-data'))})
  const proof={bundleSha256:createHash('sha256').update(bundle).digest('hex'),installedBeforeDaemon:true,activation:null,windows:[],closed:false}
  const save=()=>writeFile(path.join(root,'pruning-proof.json'),JSON.stringify(proof,null,2)+'\n')
  let client,directory,current=()=>{}
  return {
    async activate(daemon,assertCurrent){
      current=assertCurrent;directory=privatePath(daemon.project)
      client=OpenCode.make({baseUrl:daemon.url,headers:{authorization:daemon.authorization},fetch:(url,init)=>fetch(url,{...init,
        signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(30_000)])})})
      const location={directory},signal=AbortSignal.timeout(15_000)
      const entry=record=>record.data.map(item=>({id:item.id,status:item.state.status}))
      try{
        await client.location.get({location},{signal})
        const before=await client.plugin.list({location},{signal})
        proof.activation={directory,before:entry(before)}
        await save()
        await awaitNativePlugin(client,'codenomad-session-pruning',location,signal,current)
        const readiness=await presence.prepare(directory,signal,current)
        const after=await client.plugin.list({location},{signal})
        assert.equal(after.location.directory,directory)
        assert(after.data.some(item=>item.id==='codenomad-session-pruning'&&item.state.status==='active'))
        proof.activation={...proof.activation,after:entry(after),freshPresencePrepared:true,incarnation:readiness.incarnation}
      }finally{await save()}
    },
    async window(sessionID){
      current()
      const evidence={sessionID,method:'window'}
      proof.windows.push(evidence)
      try{
        const response=await client.rpc.call({rpcID:'codenomad.session-pruning',method:'window',input:{sessionID,target:{kind:'latest'}},location:{directory}},
          {signal:AbortSignal.timeout(15_000)})
        current()
        const parsed=navigationWindowResultSchema.safeParse(response.output)
        evidence.schemaValid=parsed.success
        evidence.status=typeof response.output?.status==='string'?response.output.status:'invalid'
        if(response.output?.status==='blocked')evidence.reason=response.output.reason
        assert(parsed.success&&parsed.data.status==='window','Native pruning window unavailable; inspect pruning-proof.json')
        Object.assign(evidence,{messages:parsed.data.messages.length,older:parsed.data.older!==null,newer:parsed.data.newer!==null})
      }catch(error){evidence.failed=true;throw error}
      finally{await save()}
    },
    async close(){await presence();proof.closed=true;await save()},
  }
}
