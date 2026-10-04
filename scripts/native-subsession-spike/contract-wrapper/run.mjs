import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { OpenCode } from '@opencode/client'
import { build } from 'esbuild'
import { runDynamicContractCases } from './dynamic-cases.mjs'
import { runCorrectionCases } from './correction-cases.mjs'

const experiment = 'D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003'
assert.equal(path.resolve(process.cwd()).toLowerCase(), path.resolve(experiment).toLowerCase(), 'Explicit experiment workdir only')
const cli = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe'
const frozen = 'D:/CodeNomad/.codenomad/worktrees/tauri-integrated-20261002-1841-b62f'
const monitored = ['AGENTS.md', 'package.json', 'package-lock.json', 'scripts/test-missions-continuity-spike.mjs', 'scripts/missions-child-environment/plugin.mjs', 'packages/server/src/missions/journal.ts', 'packages/server/src/missions/contracts.ts', 'packages/server/src/opencode/missions-plugin.ts', 'node_modules/@opencode/plugin/package.json', 'node_modules/@opencode/client/package.json']
const hashes = async () => Object.fromEntries(await Promise.all(monitored.map(async name => [name, createHash('sha256').update(await readFile(frozen + '/' + name)).digest('hex')])))
const before = await hashes()
const root = await mkdtemp('C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-')
const project = root + '/project', config = root + '/config', plugin = root + '/plugin'
for (const dir of [project, config, plugin]) await mkdir(dir)
await writeFile(config + '/opencode.json', '{}\n')
const baselineBundle = process.env.CODENOMAD_NATIVE_CONTRACT_BASELINE_BUNDLE
if (baselineBundle) {
  assert.equal(baselineBundle, 'C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-pBgzT8/plugin/wrapper.mjs', 'Only preserved coordinator baseline bundle')
  await writeFile(plugin + '/wrapper.mjs', await readFile(baselineBundle))
} else await build({ entryPoints: [experiment + '/packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts'], outfile: plugin + '/wrapper.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' })
const token = randomUUID()
const rpc = { id: 'private.native.contract', methods: { control: { input: { type: 'object' }, output: { type: 'object' } } }, events: {} }
await writeFile(plugin + '/index.ts', `import {installNativeMissionContracts} from './wrapper.mjs';
export default {id:'private.native.contract',async setup(ctx){
  const portable=v=>JSON.parse(JSON.stringify(v));
  // Explicit private awaited-progress fault: the actual native executor still
  // creates its own child. This probes wrapper termination, not native OS cleanup.
  await ctx.tool.transform(editor=>editor.update('subagent',definition=>{
   const native=definition.execute;
   definition.execute=(input,tool)=>native(input,{...tool,progress:async update=>{
    await tool.progress(update);
    if(input.prompt==='PRIVATE_BOUND_PROGRESS_FAILURE'&&typeof update.sessionID==='string')throw Error('Private injected error after accepted actual native progress');
   }});
  }));
 const original=(await ctx.tool.list()).find(t=>t.id==='subagent');
 const originalKeys=Object.keys(original),originalOptions=portable(original.options);
  let endpoint;
  const contract=await installNativeMissionContracts(ctx,{assertNativeIdle:async sessionID=>{
   if(!endpoint)throw Error('Owned activity admission unavailable');
   const response=await fetch(new URL('/api/session/active',endpoint),{headers:{authorization:'Basic '+Buffer.from('opencode:private').toString('base64')},signal:AbortSignal.timeout(5000)});
   const body=await response.json();
   if(!response.ok||!body.data||typeof body.data!=='object'||Array.isArray(body.data))throw Error('Unknown owned native activity');
   if(sessionID in body.data)throw Error('Native child is not idle');
  }});
  const toolFailures=[];
  await ctx.tool.transform(editor=>editor.update('subagent',definition=>{
   const native=definition.execute;
   definition.execute=async(input,tool)=>{try{return await native(input,tool)}catch(error){toolFailures.push({callID:tool.id,sessionID:tool.sessionID,error:String(error),time:Date.now()});throw error}};
  }));
  await ctx.session.hook('http.request',e=>{e.request.headers.set('x-private-session',e.sessionID);e.request.headers.set('x-private-kind',e.kind);e.request.headers.set('x-private-agent',e.agent);e.request.headers.set('x-private-model',JSON.stringify(e.model))});
 await ctx.session.hook('retry',e=>{e.decision={retry:false}});
 await ctx.rpc.register(${JSON.stringify(rpc)},{control:async i=>{
  if(i.token!==${JSON.stringify(token)})throw Error('Private fixture authority denied');
   if(i.action==='seed')return contract.seed(i.plan);
    if(i.action==='revise')return contract.revise(i.change);
    if(i.action==='toolFailures')return {failures:toolFailures};
   if(i.action==='activityEndpoint'){const u=new URL(i.url);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('Private owned loopback only');endpoint=u.href;return {configured:true};}
  if(i.action==='inspect')return portable(await contract.inspect());
  if(i.action==='catalog'){const t=(await ctx.tool.list()).find(t=>t.id==='subagent');return {originalKeys,originalOptions,currentKeys:Object.keys(t),currentOptions:portable(t.options),agents:await ctx.agent.list(),sessionMethods:Object.keys(ctx.session)};}
  throw Error('No raw tool invocation RPC');
 }});
 return ()=>contract.dispose();
}}`)
const requests = [], events = [], results = { baselineBundle: baselineBundle ?? null }, sessions = new Set(), transcripts = {}
const plans = new Map(), taskPlans = new Map(), holds = new Map(), assignedPlans = new Map()
let child, output = '', failure, stage = 'setup', client, timer, stopped
const abort = new AbortController(), deadline = Date.now() + 220000
const ref = (missionID, taskKey, revision = 1) => ({ missionID, revision, taskKey })
const call = (tool, input) => ({ tool, input, id: 'call_' + randomUUID().replaceAll('-', '') })
const sub = (contract, extra = {}) => call('subagent', { agent: 'recursive', description: 'Identical native sibling label', prompt: 'Identical native child prompt', mission: contract, ...extra })
const report = (contract, extra = {}) => call('mission_contract_report', { contract, outcome: 'completed', summary: 'Explicit business evidence', ...extra })
const task = (key, parentTaskKey = null, blockedBy = []) => ({ key, parentTaskKey, title: key, brief: 'Private bounded native proof', role: 'prototype', blockedBy })
const bindingFrom = body => {
  const text = body.messages.find(m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('MISSION_NATIVE_CONTRACT:'))?.content
  if (!text) return
  const start = text.indexOf('MISSION_NATIVE_CONTRACT:') + 'MISSION_NATIVE_CONTRACT:'.length
  return JSON.parse(text.slice(start).split('\n')[0])
}
const taskFrom = body => {
  const text = body.messages.find(m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('MISSION_NATIVE_TASK:'))?.content
  if (!text) return
  return JSON.parse(text.slice(text.indexOf('MISSION_NATIVE_TASK:') + 'MISSION_NATIVE_TASK:'.length).split('\n')[0])
}
function emit(res, answer) {
  const answers = Array.isArray(answer) ? answer : [answer]
  const delta = typeof answer === 'string' ? { role: 'assistant', content: answer } : { role: 'assistant', tool_calls: answers.map((v,index) => ({ index, id: v.id, type: 'function', function: { name: v.tool, arguments: JSON.stringify(v.input) } })) }
  res.setHeader('content-type', 'text/event-stream')
  for (const [d,finish_reason] of [[delta,null],[{},typeof answer === 'string' ? 'stop' : 'tool_calls']]) res.write('data: ' + JSON.stringify({ id: 'private', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: d, finish_reason }] }) + '\n\n')
  res.end('data: [DONE]\n\n')
}
const provider = createServer(async (req,res) => {
  try {
    let raw = ''; for await (const c of req) raw += c
    const body = JSON.parse(raw), sessionID = req.headers['x-private-session'], kind = req.headers['x-private-kind']
    const binding = kind === 'primary' ? bindingFrom(body) : undefined
    requests.push({ index: requests.length, sessionID, kind, binding, task: taskFrom(body), actual: { agent: req.headers['x-private-agent'], model: req.headers['x-private-model'] ? JSON.parse(req.headers['x-private-model']) : null }, body, time: Date.now() })
    assert(requests.length <= 200, 'Bounded provider budget')
    if (kind !== 'primary') return emit(res, 'Private title')
    if (binding && assignedPlans.get(sessionID) !== JSON.stringify([binding.missionID, binding.taskKey, binding.revision])) {
      assignedPlans.set(sessionID, JSON.stringify([binding.missionID, binding.taskKey, binding.revision]))
      plans.set(sessionID, [...(taskPlans.get(binding.missionID + '/' + binding.taskKey) ?? [])])
    }
    const step = plans.get(sessionID)?.shift()
    if (step?.hold) await new Promise(resolve => { holds.set(step.hold, resolve); res.once('close', resolve) })
    if (res.destroyed) return
    const answer = step?.answer ?? 'NATIVE_RESULT:' + sessionID
    for (const value of Array.isArray(answer) ? answer : [answer]) if (typeof value !== 'string') {
      const available = body.tools.some(t => t.function.name === value.tool)
      if (!step?.forceAbsent) assert(available, 'Real provider catalog lacks ' + value.tool)
    }
    emit(res, answer)
  } catch (error) { failure = error; res.destroy() }
})
async function until(fn, label = stage) {
  const end = Math.min(deadline, Date.now() + 30000)
  while (Date.now() < end) {
    if (failure) throw failure
    if (await fn()) return
    if (child?.exitCode != null) throw Error('Private child exited: ' + output.slice(-2000))
    await delay(40)
  }
  throw Error('Timeout ' + label)
}
const primary = id => requests.filter(r => r.sessionID === id && r.kind === 'primary')
const control = input => client.rpc(rpc).control({ token, ...input }, { location: { directory: project }, signal: AbortSignal.timeout(15000) })
const inspect = () => control({ action: 'inspect' })
const value = (proof, suffix) => proof.entries.find(e => e.key === 'private-native-contract/v1/' + suffix)?.value
const messages = async id => (await client.message.list({ sessionID: id, limit: { order: 'asc', limit: 100 } })).data
const tools = rows => rows.flatMap(m => m.content ?? []).filter(p => p.type === 'tool')
const wait = id => client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(30000) })
const create = async (name, options = {}) => { const s = await client.session.create({ title: name, location: { directory: project }, ...options }); sessions.add(s.id); return s.id }
const seed = async (id, missionID, tasks) => control({ action: 'seed', plan: { missionID, coordinatorID: id, expectedRevision: 0, objective: 'Private native Mission contract proof', tasks } })
const prompt = async (id, answers) => { plans.set(id, answers.map(answer => ({ answer }))); await client.session.prompt({ sessionID: id, text: 'Exercise actual native tool loop only' }); await wait(id) }
const release = key => { assert(holds.has(key), 'Missing actual provider hold'); holds.get(key)(); holds.delete(key) }
try {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(k)))
  Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root, APPDATA: root, LOCALAPPDATA: root, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: root + '/fixture.sqlite', OPENCODE_SERVER_PASSWORD: 'private', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_FFF: '1' })
  for (const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR']) env[key] = root + '/' + key
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'fixture/fixture', snapshots: false, update: 'disable', plugins: [plugin], experimental: { subagent_depth: 3 },
    permissions: [{ action: 'execute', resource: '*', effect: 'deny' }],
    agents: { recursive: { mode: 'all', description: 'Private recursive native agent', model: 'fixture/fixture', permissions: [{ action: 'subagent', resource: '*', effect: 'allow' }] }, recursive_sub: { mode: 'subagent', description: 'Private recursive subagent', permissions: [{ action: 'subagent', resource: '*', effect: 'allow' }] } },
    providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { apiKey: 'private', baseURL: 'http://127.0.0.1:' + provider.address().port + '/v1' }, models: { fixture: {}, selected: { variants: [{ id: 'careful' }] } } } } })
  child = spawn(cli, ['serve','--hostname','127.0.0.1','--port','0','--print-logs'], { cwd: root, env, windowsHide: true })
  stopped = new Promise(r => child.once('close', r)); child.once('error',e => { failure=e })
  child.stdout.on('data',d => output += d); child.stderr.on('data',d => output += d)
  timer = setTimeout(() => { failure = Error('Private run deadline'); child.kill(); provider.closeAllConnections() }, deadline-Date.now())
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], authorization = 'Basic ' + Buffer.from('opencode:private').toString('base64')
  client = OpenCode.make({ baseUrl: url, headers: { authorization } })
  results.server = await client.server.info(); assert.equal(results.server.version, '2.0.22')
  const openapi = await (await fetch(url+'/openapi.json',{headers:{authorization},signal:AbortSignal.timeout(10000)})).json()
  await writeFile(root+'/openapi.json',JSON.stringify(openapi,null,2))
  void (async () => { try { for await (const e of client.event.subscribe({signal:abort.signal})) events.push(e) } catch(e) { if(!abort.signal.aborted)failure=e } })()
  results.catalog = await control({action:'catalog'})
  await control({action:'activityEndpoint',url})
  assert.deepEqual(results.catalog.currentOptions, results.catalog.originalOptions)
  assert.deepEqual(results.catalog.currentKeys, results.catalog.originalKeys)

  stage = 'depth 3 native recursive foreground with explicit business reports'
  const parent = await create('native-depth-root'), mission = 'private_depth'
  await seed(parent,mission,[task('level-one'),task('level-two','level-one'),task('level-three','level-two')])
  taskPlans.set(mission+'/level-one',[{answer:sub(ref(mission,'level-two'),{agent:'recursive_sub'})},{answer:report(ref(mission,'level-one'))},{answer:'LEVEL_ONE_NATIVE_FINAL'}])
  taskPlans.set(mission+'/level-two',[{answer:sub(ref(mission,'level-three'))},{answer:report(ref(mission,'level-two'))},{answer:'LEVEL_TWO_NATIVE_FINAL'}])
  taskPlans.set(mission+'/level-three',[{answer:report({...ref(mission,'level-three'),revision:9})},{answer:report(ref(mission,'level-three'))},{answer:'LEVEL_THREE_NATIVE_FINAL'}])
  const rootCall = sub(ref(mission,'level-one'))
  await prompt(parent,[rootCall,'ROOT_CONSUMED_NATIVE_RESULT'])
  let proof = await inspect();results.depth = proof;assert(proof.nativeFieldsPreserved)
  const chain = ['level-one','level-two','level-three'].map(k=>value(proof,'owner/'+mission+'/'+k))
  assert(chain.every(Boolean)); assert.equal(chain[0].parentID,parent);assert.equal(chain[1].parentID,chain[0].childID);assert.equal(chain[2].parentID,chain[1].childID)
  for(const b of chain){sessions.add(b.childID);assert.equal((await client.session.get({sessionID:b.childID})).parentID,b.parentID);assert.deepEqual(primary(b.childID)[0].binding,b);assert(value(proof,'returned/'+b.parentID+'/'+b.callID).nativeReturned);assert.equal(value(proof,'report/'+b.missionID+'/'+b.taskKey).outcome,'completed')}
  const semanticPlan = value(proof, 'plan/' + mission)
  for (const binding of chain) {
    const semantic = primary(binding.childID)[0].task
    assert.equal(semantic.objective, semanticPlan.objective)
    assert.deepEqual(semantic.task, semanticPlan.tasks.find(task => task.key === binding.taskKey))
  }
  for(const [id,marker] of [[parent,'LEVEL_ONE_NATIVE_FINAL'],[chain[0].childID,'LEVEL_TWO_NATIVE_FINAL'],[chain[1].childID,'LEVEL_THREE_NATIVE_FINAL']]){assert(primary(id).some(r=>JSON.stringify(r.body.messages).includes(marker)), 'Actual native parent consumed child return');assert(primary(id).some(r=>JSON.stringify(r.body.messages).includes('MISSION_BUSINESS_REPORT_REFERENCE:')), 'Actual native parent consumed business report reference on the native return path')}
  const leafTools = tools(await messages(chain[2].childID));assert(leafTools.some(p=>p.state.status==='error'));assert(leafTools.some(p=>p.state.status==='completed'))
  assert.equal(proof.snapshot.discardedEvents,0)
  assert.equal(proof.snapshot.missions.find(m=>m.id===mission).reports.length,3)
  assert.equal(events.filter(e=>e.type==='session.created'&&chain.some(b=>b.childID===e.data.sessionID)).length,3)
  const firstSchema = primary(parent)[0].body.tools.find(t=>t.function.name==='subagent').function.parameters
  assert(firstSchema.properties.mission); assert.equal(firstSchema.additionalProperties,false)
  results.modelSchema = firstSchema

  stage = 'concurrent overlapping siblings, identical agent/description/prompt'
  const siblings = await create('native-siblings-root'), sm = 'private_siblings'
  await seed(siblings,sm,[task('sibling-a'),task('sibling-b')])
  for(const k of ['sibling-a','sibling-b'])taskPlans.set(sm+'/'+k,[{hold:k,answer:report(ref(sm,k))},{answer:k+'_NATIVE_FINAL'}])
  const siblingCalls = [sub(ref(sm,'sibling-a')),sub(ref(sm,'sibling-b'))]
  plans.set(siblings,[{answer:siblingCalls},{answer:'SIBLINGS_NATIVE_CONSUMED'}]);await client.session.prompt({sessionID:siblings,text:'Actual concurrent tools in one native assistant response'})
  await until(()=>holds.has('sibling-a')&&holds.has('sibling-b'),'Both native siblings concurrently in first provider requests')
  proof=await inspect();const siblingBindings=['sibling-a','sibling-b'].map(k=>value(proof,'owner/'+sm+'/'+k))
  assert.equal(new Set(siblingBindings.map(b=>b.callID)).size,2);assert.equal(new Set(siblingBindings.map(b=>b.childID)).size,2)
  assert(siblingBindings.every(b=>b.parentID===siblings));for(const b of siblingBindings){sessions.add(b.childID);assert.deepEqual(primary(b.childID)[0].binding,b)}
  release('sibling-b');release('sibling-a');await wait(siblings)
  proof=await inspect();results.siblings={bindings:siblingBindings,proof}
  assert.equal(proof.snapshot.missions.find(m=>m.id===sm).reports.length,2)
  assert.equal(tools(await messages(siblings)).filter(p=>p.name==='subagent').length,2)
  assert.equal((await messages(siblings)).filter(m=>m.type==='synthetic').length,0,'No second synthetic report notification')

  stage = 'same-child continuation and foreign continuation'
  const count = events.filter(e=>e.type==='session.created'&&e.data.parentID===siblings).length
  await prompt(siblings,[sub(ref(sm,'sibling-a'),{sessionID:siblingBindings[0].childID})])
  assert.equal(events.filter(e=>e.type==='session.created'&&e.data.parentID===siblings).length,count)
  const foreign = await create('foreign-root');let childRequests=primary(siblingBindings[0].childID).length
  await prompt(foreign,[sub(ref(sm,'sibling-a'),{sessionID:siblingBindings[0].childID})])
  assert.equal(tools(await messages(foreign))[0].state.status,'error');assert.equal(primary(siblingBindings[0].childID).length,childRequests)
  results.continuation={sameChild:siblingBindings[0].childID,foreignRejected:true}

  stage = 'reject already-owned duplicate launches before native child creation'
  const existingBefore = await inspect(), existingBirths = events.filter(e => e.type === 'session.created' && e.data.parentID === siblings).length
  const duplicateCalls = [sub(ref(sm, 'sibling-a')), sub(ref(sm, 'sibling-a'))]
  await prompt(siblings, [duplicateCalls])
  const existingAfter = await inspect(), duplicateParts = tools(await messages(siblings))
  assert(duplicateCalls.every(call => duplicateParts.find(part => part.id === call.id)?.state.status === 'error'))
  assert.equal(events.filter(e => e.type === 'session.created' && e.data.parentID === siblings).length, existingBirths)
  assert.deepEqual(existingAfter.snapshot.missions, existingBefore.snapshot.missions)
  assert.deepEqual(existingAfter.entries, existingBefore.entries)
  results.duplicateOwned = { rejectedCalls: duplicateCalls.map(call => call.id), extraBirths: 0, mapAndBindingsUnchanged: true }

  stage = 'concurrent fresh same-task calls share one actual native actor'
  const raceRoot = await create('same-task-concurrent-root'), raceMission = 'private_same_task'
  const raceTask = { ...task('race-task'), title: 'SEMANTIC_RACE_TITLE', brief: 'SEMANTIC_RACE_BRIEF', role: 'semantic-role' }
  const dependentTask = { ...task('after-race', null, ['race-task']), title: 'SEMANTIC_DEPENDENT_TITLE', brief: 'SEMANTIC_DEPENDENT_BRIEF', role: 'semantic-role' }
  await seed(raceRoot, raceMission, [raceTask, dependentTask])
  taskPlans.set(raceMission + '/race-task', [{ hold: 'same-task-first', answer: report(ref(raceMission, 'race-task')) }, { answer: 'RACE_NATIVE_FINAL' }])
  const raceCalls = [sub(ref(raceMission, 'race-task')), sub(ref(raceMission, 'race-task'))]
  plans.set(raceRoot, [{ answer: raceCalls }, { answer: 'RACE_RESULT_CONSUMED' }])
  await client.session.prompt({ sessionID: raceRoot, text: 'Two real same-task native calls in one assistant response' })
  await until(() => holds.has('same-task-first') && raceCalls.every(call => events.some(event => event.type === 'session.tool.called' && event.data.id === call.id)), 'Both native same-task calls admitted while first child is held')
  const heldProof = await inspect(), raceOwner = value(heldProof, 'owner/' + raceMission + '/race-task')
  assert(raceOwner); sessions.add(raceOwner.childID)
  assert.equal(events.filter(e => e.type === 'session.created' && e.data.parentID === raceRoot).length, 1)
  assert.equal(primary(raceOwner.childID).length, 1)
  assert.deepEqual(primary(raceOwner.childID)[0].task.task, raceTask)
  release('same-task-first'); await wait(raceRoot)
  const raceProof = await inspect(), raceParts = tools(await messages(raceRoot))
  assert.equal(events.filter(e => e.type === 'session.created' && e.data.parentID === raceRoot).length, 1)
  assert.equal(raceCalls.filter(call => raceParts.find(part => part.id === call.id)?.state.status === 'completed').length, 1)
  assert.equal(raceCalls.filter(call => raceParts.find(part => part.id === call.id)?.state.status === 'error').length, 1)
  assert.equal(raceProof.snapshot.missions.find(mission => mission.id === raceMission).reports.length, 1)
  assert.equal(value(raceProof, 'owner/' + raceMission + '/race-task').childID, raceOwner.childID)
  taskPlans.set(raceMission + '/after-race', [{ answer: report(ref(raceMission, 'after-race')) }, { answer: 'DEPENDENT_NATIVE_FINAL' }])
  await prompt(raceRoot, [sub(ref(raceMission, 'after-race'))])
  const dependentOwner = value(await inspect(), 'owner/' + raceMission + '/after-race'); sessions.add(dependentOwner.childID)
  const dependentContext = primary(dependentOwner.childID)[0].task
  assert.deepEqual(dependentContext.task, dependentTask)
  assert.deepEqual(dependentContext.dependencies, [{ taskKey: 'race-task', outcome: 'completed' }])
  results.sameTaskRace = { rootID: raceRoot, calls: raceCalls.map(call => call.id), childID: raceOwner.childID, taskBirths: 1, extraBirths: 0, semanticContext: primary(raceOwner.childID)[0].task, dependentContext }

  stage = 'nested self and in-flight ancestor references reject without waiting on their locks'
  const wrongRoot = await create('wrong-parent-nested-root'), wrongMission = 'private_wrong_parent'
  await seed(wrongRoot, wrongMission, [task('outer-task'), task('inner-task', 'outer-task')])
  const wrongCalls = [sub(ref(wrongMission, 'inner-task')), sub(ref(wrongMission, 'outer-task'))]
  taskPlans.set(wrongMission + '/outer-task', [{ answer: sub(ref(wrongMission, 'inner-task')) }, { answer: report(ref(wrongMission, 'outer-task')) }, { answer: 'OUTER_NATIVE_FINAL' }])
  taskPlans.set(wrongMission + '/inner-task', [{ hold: 'wrong-parent-before', answer: wrongCalls }, { hold: 'wrong-parent-after', answer: report(ref(wrongMission, 'inner-task')) }, { answer: 'INNER_NATIVE_FINAL' }])
  plans.set(wrongRoot, [{ answer: sub(ref(wrongMission, 'outer-task')) }, { answer: 'WRONG_PARENT_ERRORS_CONSUMED' }])
  await client.session.prompt({ sessionID: wrongRoot, text: 'Nested invalid self/ancestor contracts while both native parent calls remain in flight' })
  await until(() => holds.has('wrong-parent-before'))
  const wrongBefore = await inspect(), innerOwner = value(wrongBefore, 'owner/' + wrongMission + '/inner-task')
  const outerOwner = value(wrongBefore, 'owner/' + wrongMission + '/outer-task')
  assert(innerOwner && outerOwner); sessions.add(innerOwner.childID); sessions.add(outerOwner.childID)
  const wrongBirths = events.filter(event => event.type === 'session.created').length
  release('wrong-parent-before')
  await until(() => holds.has('wrong-parent-after'), 'Both invalid nested calls return before either enclosing native call ends')
  const wrongAfter = await inspect(), wrongParts = tools(await messages(innerOwner.childID))
  assert(wrongCalls.every(call => wrongParts.find(part => part.id === call.id)?.state.status === 'error'))
  assert(wrongCalls.every(call => wrongParts.find(part => part.id === call.id)?.state.error.message.includes('Contract parent is not')))
  assert.equal(events.filter(event => event.type === 'session.created').length, wrongBirths)
  assert.deepEqual(wrongAfter.snapshot.missions, wrongBefore.snapshot.missions)
  assert.deepEqual(wrongAfter.entries, wrongBefore.entries)
  for (const call of wrongCalls) assert(primary(innerOwner.childID).at(-1).body.messages.some(message => message.role === 'tool' && message.tool_call_id === call.id && JSON.stringify(message.content).includes('Contract parent is not')))
  results.wrongParent = { rootID: wrongRoot, outerID: outerOwner.childID, innerID: innerOwner.childID, calls: wrongCalls.map(call => call.id), before: wrongBefore, after: wrongAfter, extraBirths: 0, rejectedWhileAncestorsInFlight: true }
  release('wrong-parent-after'); await wait(wrongRoot)
  assert.equal((await inspect()).snapshot.missions.find(mission => mission.id === wrongMission).reports.length, 2)
  assert(primary(wrongRoot).some(request => JSON.stringify(request.body.messages).includes('OUTER_NATIVE_FINAL')))

  stage = 'unadmitted stale revision/dependencies and parent native permission'
  const deny = await create('native-denied-root',{permissions:[{action:'subagent',resource:'recursive',effect:'deny'}]}), dm='private_denied'
  await seed(deny,dm,[task('denied-task')]);const initial=await inspect()
  await prompt(deny,[sub(ref(dm,'denied-task'))]);assert.equal(tools(await messages(deny))[0].state.status,'error')
  assert(!events.some(e=>e.type==='session.created'&&e.data.parentID===deny));proof=await inspect();assert(!value(proof,'owner/'+dm+'/denied-task'))
  assert.deepEqual(initial.snapshot.missions.find(m=>m.id===dm),proof.snapshot.missions.find(m=>m.id===dm))
  const pending=await create('pending-root'),pm='private_pending';await seed(pending,pm,[task('pending-task'),task('blocked-task',null,['pending-task'])]);const pendingBefore=(await inspect()).snapshot.missions.find(m=>m.id===pm)
  await prompt(pending,[sub(ref(pm,'pending-task',99)),sub(ref(pm,'blocked-task'))]);proof=await inspect();assert.deepEqual(proof.snapshot.missions.find(m=>m.id===pm),pendingBefore)
  assert(!events.some(e=>e.type==='session.created'&&e.data.parentID===pending))
  await prompt(pending,[sub(ref(pm,'pending-task'))]);proof=await inspect();const noReport=proof.snapshot.missions.find(m=>m.id===pm).tasks.find(t=>t.key==='pending-task');assert.equal(noReport.status,'queued');assert.equal(noReport.report,undefined)
  const pendingChild=value(proof,'owner/'+pm+'/pending-task').childID;sessions.add(pendingChild);assert.equal((await client.session.get({sessionID:pendingChild})).outcome,'succeeded')
  results.admissionVsCompletion={nativeSucceeded:true,businessTaskStatus:noReport.status}
  results.denial={noChild:true,noContractEffect:true};results.unadmitted={staleRevision:true,dependencyBlocked:true,pendingUnchanged:true}

  stage = 'builtin General recursion negative control'
  const generalRoot=await create('general-negative-root'),gm='private_general';await seed(generalRoot,gm,[task('general-task'),task('forbidden-child','general-task')])
  taskPlans.set(gm+'/general-task',[{answer:sub(ref(gm,'forbidden-child')),forceAbsent:true},{answer:'GENERAL_NATIVE_NEGATIVE_FINISHED'}])
  await prompt(generalRoot,[sub(ref(gm,'general-task'),{agent:'general'})]);proof=await inspect();const gb=value(proof,'owner/'+gm+'/general-task');sessions.add(gb.childID)
  assert(!primary(gb.childID)[0].body.tools.some(t=>t.function.name==='subagent'));assert(!value(proof,'owner/'+gm+'/forbidden-child'))
  assert(!events.some(e=>e.type==='session.created'&&e.data.parentID===gb.childID));results.general={nativeRecursionDeniedByBuiltin:true}
  stage = 'mutable contracts, native execution choices, exact-child rebinding and retirement'
  results.dynamic = await runDynamicContractCases({ client, create, seed, control, inspect, value, ref, sub, report, task, plans, taskPlans, holds, until, release, wait, prompt, primary, messages, tools, events, sessions, baseline: !!baselineBundle })
  stage = 'review corrections: failed bound invocation, busy same-task and actor cap'
  results.corrections = await runCorrectionCases({ client, create, seed, control, inspect, value, ref, sub, task, plans, taskPlans, holds, until, release, wait, prompt, primary, messages, tools, events, sessions, baseline: !!baselineBundle, record: evidence => { results.correctionProgress = evidence } })
  results.beforeReload=await inspect()
  stage='explicit private location reload preserves actual native plugin storage'
  await client.location.reload({signal:AbortSignal.timeout(20000)})
  results.afterReload=await inspect();assert.deepEqual(results.afterReload.entries,results.beforeReload.entries)
  assert.deepEqual(results.afterReload.snapshot.missions,results.beforeReload.snapshot.missions)
  results.persistedReload=true
  results.status=baselineBundle ? 'baseline-reproduced' : 'passed'
}catch(error){results.status='failed';results.failure={stage,error:String(error),detail:error,providerFailure:failure?String(failure):null,stack:error.stack};console.error('FAIL',stage,root);process.exitCode=1}
finally{
  clearTimeout(timer);for(const r of holds.values())r();abort.abort()
  if(client){for(const e of events)if(e.type==='session.created')sessions.add(e.data.sessionID);for(const id of sessions)try{transcripts[id]=await messages(id)}catch(e){transcripts[id]={error:String(e)}}}
  const after=await hashes();results.frozenHashes={before,after,unchanged:JSON.stringify(before)===JSON.stringify(after)}
  assert.deepEqual(after,before,'Frozen candidate files remain byte-identical')
  results.counts={providerRequests:requests.length,primaryRequests:requests.filter(r=>r.kind==='primary').length,nativeSessions:sessions.size,nativeEvents:events.length}
  results.executedBundleHash=createHash('sha256').update(await readFile(plugin+'/wrapper.mjs')).digest('hex')
  results.sourceHashes=Object.fromEntries(await Promise.all(['scripts/native-subsession-spike/contract-wrapper/run.mjs','scripts/native-subsession-spike/contract-wrapper/dynamic-cases.mjs','scripts/native-subsession-spike/contract-wrapper/correction-cases.mjs','packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts','packages/server/src/missions/native-subsession-experiment/contract-plan.ts','packages/server/src/missions/native-subsession-experiment/contract-execution.ts','packages/server/src/missions/native-subsession-experiment/contract-capacity.ts','packages/server/src/missions/model.ts','packages/server/src/missions/journal.ts'].map(async file=>[file,createHash('sha256').update(await readFile(experiment+'/'+file)).digest('hex')])))
  await Promise.all([['results.json',results],['requests.json',requests],['events.json',events],['transcripts.json',transcripts]].map(([file,data])=>writeFile(root+'/'+file,JSON.stringify(data,null,2))))
  await writeFile(root+'/serve.log',output)
  child?.kill();if(stopped)await stopped;provider.closeAllConnections();await new Promise(r=>provider.close(r))
  console.log(results.status?.toUpperCase(),root,JSON.stringify(results.counts),results.failure?.error??'')
}
