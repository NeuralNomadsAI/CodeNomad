// CPU-buffer readiness through the real Rune runtime; no native window or virtual clock.
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fixtureChildPid,spawnFixtureChild,stopFixtureChild} from '../native-fixture-guards.mjs'
import {createAttestedRelay,createStreamRedactor,redactSecrets,resolveLocalExecutable,withoutFixtureProxy} from '../native-fixture-http.mjs'
import {registerFixtureChild} from '../../packages/rune-app/fixtures/fixture-host.mjs'
import {MARKER, now, sleep} from './lib.mjs'
import {withBackend} from './stacks.mjs'

export function correlateClock(samples) {
  assert(samples.length > 0, 'Missing Rune clock samples')
  for (const sample of samples) assert([sample.before, sample.after, sample.remote].every(Number.isFinite)
    && sample.after >= sample.before && sample.remote >= 0, 'Invalid Rune clock sample')
  const lower = Math.max(...samples.map(sample => sample.remote - sample.after))
  const upper = Math.min(...samples.map(sample => sample.remote - sample.before))
  assert(lower <= upper, 'Rune clock samples have incompatible monotonic offsets')
  return {offsetMs: (lower + upper) / 2, lowerOffsetMs: lower, upperOffsetMs: upper,
    uncertaintyMs: (upper - lower) / 2, minimumRoundTripMs: Math.min(...samples.map(sample => sample.after - sample.before)), samples: samples.length}
}
export function observation(value, clock) {
  assert(Number.isInteger(value.paintedFrames) && value.paintedFrames > 0, 'Rune must report real CPU-painted frames')
  const marker = new RegExp(`^(?:${MARKER.source})$`)
  assert(value.shown && typeof value.shown === 'object' && !Array.isArray(value.shown), 'Missing Rune marker observations')
  return {shown: Object.fromEntries(Object.entries(value.shown).map(([key, time]) => {
    assert(marker.test(key) && Number.isFinite(time) && time >= 0, 'Invalid Rune painted marker')
    return [key, time - clock.offsetMs]
  }))}
}

export async function withRune(binary, rustBinary, daemon, session, root, run) {
  binary = resolveLocalExecutable(binary, 'Rune client binary')
  rustBinary = resolveLocalExecutable(rustBinary, 'Rust server binary')
  assert.equal((await daemon.call('GET','/api/info')).pid,daemon.pid,'Rune workload must use the owned benchmark daemon')
  assert(daemon.pruning,'Rune benchmark requires explicitly provisioned pruning capability')
  await daemon.pruning.window(session)
  return withBackend(daemon, undefined, root, false, async (origin, cookie, {password, backendPid, fetch: backendFetch}) => {
    const opened = await backendFetch(`${origin}/api/workspaces`, {method: 'POST', headers: {'content-type': 'application/json', cookie: `codenomad_session=${cookie}`},
      body: JSON.stringify({path: daemon.project}), signal: AbortSignal.timeout(30_000)})
    assert(opened.ok, `Rune benchmark workspace failed (${opened.status})`)
    const workspace = await opened.json()
    assert(typeof workspace.id === 'string' && workspace.id.length > 0, 'Missing private workspace identity')
    const history=await backendFetch(`${origin}/api/workspaces/${workspace.id}/session-history/window`,{method:'POST',
      headers:{'content-type':'application/json',cookie:`codenomad_session=${cookie}`},body:JSON.stringify({sessionID:session,target:{kind:'latest'}}),signal:AbortSignal.timeout(20_000)})
    const historyBody=await history.json()
    await writeFile(path.join(root,'history-capability.json'),JSON.stringify({nativeWindowProven:true,httpStatus:history.status,
      status:historyBody.status??'invalid',reason:historyBody.reason,messages:Array.isArray(historyBody.messages)?historyBody.messages.length:undefined},null,2))
    assert(history.ok&&historyBody.status==='window','Rust history capability unavailable; inspect history-capability.json and native pruning-proof.json')
    const rustRelay = await createAttestedRelay(origin, backendPid, {requireClientAttestation: true})
    try {
    const group = process.platform !== 'win32'
    const child = spawnFixtureChild(binary, ['--probe-latency','--tree',path.join(root,'unexpected-product-tree.json'),'--at','0'], {cwd: root, detached: group, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: withoutFixtureProxy({...daemon.env, RUNE_BACKEND: `${rustRelay.origin}/`, RUNE_WORKSPACE: workspace.id, RUNE_SESSION: session, RUNE_PASSWORD: password, RUNE_LOCALE: 'en'})})
    const startedBy = new Date()
    const pending = new Map()
    const errRedactor = createStreamRedactor([password, daemon.password])
    let serial = 0, buffer = '', stderr = '', failure
    const appendStderr = chunk => { if (chunk) stderr = (stderr + chunk).slice(-64 * 1024) }
    const rejectAll = error => {failure ??= error; for (const task of pending.values()) task.reject(error); pending.clear()}
    const stopped = new Promise(resolve => {child.once('error', error => {rejectAll(error); resolve()}); child.once('close', code => {appendStderr(errRedactor.flush()); rejectAll(Error(`Rune latency probe exited (${code})`)); resolve(code)})})
    rustRelay.allowClientPid(fixtureChildPid(child), stopped)
    const untrack = registerFixtureChild(() => stopFixtureChild(child, stopped, 1_000, 2_000, {group, startedBy}))
    void stopped.finally(untrack)
    child.stderr.on('data', chunk => {appendStderr(errRedactor.push(chunk))})
    child.stdout.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 256 * 1024) return rejectAll(Error('Rune latency response exceeds its bound'))
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        try {
          const value = JSON.parse(line), task = pending.get(value.id)
          assert(task, 'Unknown Rune latency response identity')
          pending.delete(value.id)
          if (value.ok !== true) task.reject(Error(`Rune CPU measurement refused the sample${/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.error??'') ? ` (${value.error})` : ''}`))
          else task.resolve(value)
        } catch {rejectAll(Error('Invalid Rune latency response'))}
      }
    })
    child.stdin.on('error', () => rejectAll(Error('Rune latency command pipe closed')))
    async function call(op, fields = {}) {
      if (failure) throw failure
      assert(pending.size < 8, 'Rune latency command queue reached its bound')
      const id = ++serial
      let timer
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => {pending.delete(id); reject(Error(`Rune latency ${op} timed out`))}, 60_000)
          pending.set(id, {resolve, reject})
          child.stdin.write(JSON.stringify({id, op, ...fields}) + '\n')
        })
      } finally {clearTimeout(timer)}
    }
    async function clock() {
      const samples = []
      for (let i = 0; i < 5; i++) {
        const before = now(), value = await call('clock'), after = now()
        assert.equal(value.clock, 'monotonic-ms'); assert.equal(value.stage, 'cpu-buffer')
        samples.push({before, after, remote: value.nowMs})
      }
      return correlateClock(samples)
    }
    let startClock, endClock, completed=false, paintedFrames=0
    try {
      startClock = await clock()
      await run({
        async arm(counters) {assert(!counters, 'Rune adapter measures latency only'); await call('arm')},
        async collect() {const value=await call('collect');await writeFile(path.join(root,'rune-observation.json'),JSON.stringify(value,null,2));const result=observation(value,startClock);paintedFrames=value.paintedFrames;return result},
        async typeKey(index) {
          const at = now(), value = await call('typeKey', {index})
          const elapsed = value.shownAtMs - startClock.offsetMs - at
          assert(Number.isFinite(elapsed) && elapsed >= 0, 'Invalid Rune key-to-painted-buffer latency')
          return {at, elapsed}
        },
        async clear() {
          await call('clear')
          endClock = await clock()
          assert(Math.max(startClock.lowerOffsetMs, endClock.lowerOffsetMs) <= Math.min(startClock.upperOffsetMs, endClock.upperOffsetMs), 'Rune clock offset drifted outside its measured uncertainty')
        },
        metadata: () => ({endpoint: 'rune-cpu-buffer', paintedFrames, clock: {start: startClock, end: endClock}}),
      })
      completed=true
    } finally {
      let graceful=false
      try {
        if(child.exitCode===null&&!failure){await call('stop');await Promise.race([stopped,sleep(2000,undefined,{ref:false})]);graceful=child.exitCode===0}
      } catch {}
      try {await stopFixtureChild(child, stopped, 1_000, 2_000, {group, startedBy})} finally {
        await writeFile(path.join(root, 'rune-probe.log'), redactSecrets(stderr + errRedactor.peek(), [password, daemon.password]))
      }
      if(completed)assert(graceful,'Rune latency probe must acknowledge stop and exit 0')
    }
    } finally {
      await rustRelay.close().catch(() => {})
    }
  }, {rustBinary})
}
