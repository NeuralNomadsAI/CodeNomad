import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {textStream} from './fixture-response.mjs'

export function webLiveFixture({stores, project, streams}) {
  const sessionID = 'ses_existing', store = stores.get(sessionID)
  const baseline = store.rows.length
  let live, held = false, phase = 'live'
  const emit = (type, data) => {
    const row = {id:randomUUID(), type, created:Date.now(), location:{directory:project}, data:{sessionID,...data}}
    for (const stream of streams) stream.write(`data: ${JSON.stringify(row)}\n\n`)
  }
  return {
    get held() { return held },
    restartHistory() {
      assert.equal(phase,'reset')
      store.append('assistant','Mobile Rust restart history')
    },
    async command(action, http) {
      if (action === 'pair') {
        const response = await http.post('/api/remote-control/pairings')
        assert(response.ok())
        return (await response.json()).url
      }
      if (action === 'revoke') {
        const response = await http.get('/api/remote-control/devices')
        assert(response.ok())
        const {devices} = await response.json()
        assert.equal(devices.length,1)
        assert((await http.delete(`/api/remote-control/devices/${devices[0].id}`)).ok())
        return
      }
      assert.equal(action, phase)
      switch (action) {
        case 'live': {
          assert(streams.size)
          live = store.append('assistant', '', false)
          store.rows.pop() // A history read cannot satisfy the live-message assertion.
          emit('session.step.started', {assistantMessageID:live.id, agent:'fixture', model:{providerID:'fixture',id:'fixture'}})
          textStream(live,emit).append('Mobile live SSE only')
          phase = 'cut'
          break
        }
        case 'cut':
          assert(streams.size)
          held = true
          for (const stream of streams) stream.destroy()
          live.time.completed = Date.now()
          store.rows.push(live)
          store.append('assistant', 'Mobile recovered history')
          phase = 'resume'
          break
        case 'resume':
          held = false
          phase = 'reset'
          break
        case 'reset':
          store.rows.length = baseline
          phase = 'live'
          break
      }
    },
  }
}
