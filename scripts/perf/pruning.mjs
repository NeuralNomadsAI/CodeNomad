// Provision only the owned Rune benchmark daemon, using the production installer and RPC contract.
import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {fixtureChildPid, spawnFixtureChild, stopFixtureChild} from '../native-fixture-guards.mjs'
import {assertWorktreeModuleResolution,fixtureFetch,fixtureTarget,resolveWorktreePackage,withoutFixtureProxy,worktreeDependencyRoots} from '../native-fixture-http.mjs'
import {registerFixtureChild} from '../../packages/rune-app/fixtures/fixture-host.mjs'
import {fixtureSystemEnvironment} from '../../packages/rune-app/fixtures/private-profile.mjs'
import {privatePath} from './isolation.mjs'

export async function preparePruning(root, config, buildEnv, { onBuilderSpawn } = {}) {
  const {repoRootReal,nodeModulesReal}=worktreeDependencyRoots()
  const esbuildUrl = resolveWorktreePackage('esbuild')
  const esbuildBinSpec = process.platform === 'win32'
    ? `@esbuild/win32-${process.arch}/esbuild.exe`
    : `@esbuild/${process.platform}-${process.arch}/bin/esbuild`
  const esbuildBinaryPath = fileURLToPath(resolveWorktreePackage(esbuildBinSpec))
  // Pin ESBUILD_BINARY_PATH in the caller process before loading tsx so tsImport never honors an inherited external binary.
  process.env.ESBUILD_BINARY_PATH = esbuildBinaryPath
  const openCodeUrl = resolveWorktreePackage('@opencode/client')
  const tsxUrl = resolveWorktreePackage('tsx/esm/api')
  const navigationContractPath = fileURLToPath(new URL('../../packages/server/src/opencode/session-pruning/navigation-contract.ts', import.meta.url))
  // Verify the actual transitive dependency resolved from navigation-contract.ts stays inside the worktree boundary.
  assertWorktreeModuleResolution('zod', navigationContractPath)
  const [{OpenCode},{tsImport}]=await Promise.all([
    import(openCodeUrl),
    import(tsxUrl),
  ])
  root=privatePath(root);config=privatePath(config)
  const folder=privatePath(path.join(root,'pruning-build'))
  await mkdir(folder,{recursive:true})
  const outfile=path.join(folder,'plugin.mjs')
  const entryPoint=fileURLToPath(new URL('../../packages/server/src/opencode/session-pruning/desktop-plugin.ts',import.meta.url))
  const pluginBuildUrl=new URL('../../packages/server/scripts/native-plugin-build.mjs',import.meta.url).href
  const buildScript=`
    import { realpathSync } from 'node:fs'
    import path from 'node:path'
    const [esbuildUrl, pluginBuildUrl, entryPoint, outfile, repoRootReal, nodeModulesReal] = process.argv.slice(1)
    const isWithin = (base, target) => {
      const rel = path.relative(base, target)
      return rel === '' || (Boolean(rel) && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..')
    }
    const boundaryPlugin = {
      name: 'codenomad-worktree-boundary',
      setup(build) {
        build.onLoad({ filter: /.*/, namespace: 'file' }, args => {
          const resolved = realpathSync(args.path)
          if (!isWithin(repoRootReal, resolved) && !isWithin(nodeModulesReal, resolved)) {
            throw Error('Pruning bundle input resolved outside worktree boundary: ' + resolved)
          }
          return null
        })
      },
    }
    const [{ build }, { nativePluginBuild }] = await Promise.all([import(esbuildUrl), import(pluginBuildUrl)])
    await build({
      ...nativePluginBuild,
      plugins: [...(nativePluginBuild.plugins ?? []), boundaryPlugin],
      entryPoints: [entryPoint],
      outfile,
      banner: { js: '// CodeNomad plugin IDs: ["codenomad-session-pruning"]\\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    })
  `
  const group = process.platform !== 'win32'
  const isolatedBuildEnv = withoutFixtureProxy({ ...(buildEnv ?? fixtureSystemEnvironment()), ESBUILD_BINARY_PATH: esbuildBinaryPath })
  const builder = spawnFixtureChild(process.execPath, ['--input-type=module', '-e', buildScript, esbuildUrl, pluginBuildUrl, entryPoint, outfile, repoRootReal, nodeModulesReal], {
    cwd: root, env: isolatedBuildEnv, detached: group, gate: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const startedBy = new Date()
  let buildStderr = ''
  builder.stderr.on('data', chunk => { buildStderr = (buildStderr + chunk).slice(-32768) })
  builder.stdout.resume()
  const buildClosed = new Promise(resolve => {
    builder.once('close', code => resolve(code))
    builder.once('error', () => resolve(1))
  })
  const untrackBuilder = registerFixtureChild(() => stopFixtureChild(builder, buildClosed, 1000, 2000, { group, startedBy }))
  void buildClosed.finally(untrackBuilder)
  try {
    if (typeof onBuilderSpawn === 'function') {
      await onBuilderSpawn({ supervisorPid: builder.pid, childPid: fixtureChildPid(builder), closed: buildClosed })
    }
  } catch (error) {
    builder.abortGate?.()
    await stopFixtureChild(builder, buildClosed, 1000, 2000, { group, startedBy }).catch(() => {})
    throw error
  }
  builder.releaseGate?.()
  const buildCode = await Promise.race([
    buildClosed,
    new Promise(resolve => setTimeout(() => resolve(124), 60_000).unref()),
  ])
  if (buildCode === 124) await stopFixtureChild(builder, buildClosed, 1000, 2000, { group, startedBy })
  assert.equal(buildCode, 0, `Isolated pruning plugin build failed (${buildCode}): ${buildStderr}`)
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
      const transport=daemon.send??(async(input,init={})=>{
        const request=input instanceof Request?input:new Request(input,init)
        const target=fixtureTarget(request.url,daemon.url)
        assert(target,'Pruning client cannot address a foreign OpenCode origin')
        const headers=new Headers(request.headers)
        if(daemon.authorization)headers.set('authorization',daemon.authorization)
        return fixtureFetch(request,{headers})
      })
      client=OpenCode.make({baseUrl:daemon.url,fetch:(url,init)=>transport(new Request(url,init))})
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
