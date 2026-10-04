import assert from 'node:assert/strict'
import { writeFile, access } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { run, call } from './qualification/harness.mjs'

// Matched root controls: distinguish a native Shell cancellation limit from a
// recursive-subsession-specific limit. Effects touch this fixture's files only.
await run('root-Shell-cancellation-controls', async h => {
  await writeFile(`${h.project}/root-effect.cjs`, `const fs=require('fs'),name=process.argv[2];fs.writeFileSync(name+'.started','started');const end=Date.now()+8000;const t=setInterval(()=>{if(fs.existsSync(name+'.release')){clearInterval(t);fs.writeFileSync(name+'.effect','effect');console.log('ROOT_EFFECT_FINISHED');}else if(Date.now()>end){clearInterval(t);process.exit(2)}},40)`)
  const exists = async name => { try { await access(`${h.project}/${name}`); return true } catch { return false } }
  for (const [name, background] of [['root_foreground_interrupt', false], ['root_background_remove', true]]) {
    const rootID = await h.parent(name)
    await h.control(rootID, 'running', { gate: true })
    await h.submit(rootID, [call('shell', { command: `node root-effect.cjs ${name}`, background }, name + '_shell')])
    await h.until(() => exists(name + '.started'), 'Root shell actually executing')
    const shells = await h.running.client.shell.list({ location: { directory: h.project } }, h.options())
    const shell = shells.data.find(item => item.command === `node root-effect.cjs ${name}`)
    assert(shell && shell.status === 'running')
    const count = h.requests().length
    await h.control(rootID, 'stopped', { gate: true })
    if (background) await h.running.client.shell.remove({ id: shell.id, location: { directory: h.project } }, h.options())
    else await h.running.client.session.interrupt({ sessionID: rootID, resume: false }, h.options())
    await writeFile(`${h.project}/${name}.release`, 'private test release')
    await h.wait(rootID)
    await delay(250)
    const effect = await exists(name + '.effect')
    assert.equal(h.requests().length, count, 'No new provider requests after Stop')
    assert.equal(h.events.filter(event => event.type === 'session.created' && event.data.parentID === rootID).length, 0)
    h.observe(name, effect ? 'OBSERVED_LIMIT' : 'WORKAROUND_TESTED', { rootID, background, shellID: shell.id, nativeChildBirths: 0, filesystemEffectAfterStop: effect, providerRequestsAfterStop: 0, scope: 'Root control only; not atomic process-tree suspension' })
  }
})
