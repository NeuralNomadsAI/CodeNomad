import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {textStream} from './fixture-response.mjs'
import {androidLive,androidPrompt} from '../../../scripts/rune/web-android-contract.mjs'

export function webLiveFixture({stores, project, streams, compare}) {
  const sessionID = 'ses_existing', store = stores.get(sessionID)
  const baseline = store.rows.length
  let live, turnRecord, rejectedReconnect, held = false, phase = 'live'
  const emit = (type, data) => {
    const row = {id:randomUUID(), type, created:Date.now(), location:{directory:project}, data:{sessionID,...data}}
    for (const stream of streams) stream.write(`data: ${JSON.stringify(row)}\n\n`)
  }
  const startReply=body=>{
    assert(streams.size)
    live=store.append('assistant','',false)
    store.rows.pop() // An authoritative read cannot satisfy the live-message assertion.
    emit('session.step.started',{assistantMessageID:live.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
    textStream(live,emit).append(body)
    phase='cut'
  }
  return {
    get held() { if(held)rejectedReconnect?.();return held },
    menuLive(record) {
      assert.equal(record.id,sessionID)
      assert.equal(phase,'live')
      record.time.busy=Date.now()
      startReply('Mobile menu live reply')
    },
    androidTurn(record,body){
      assert.equal(phase,'live')
      assert.equal(record.id,sessionID)
      assert.equal(body.text,androidPrompt)
      turnRecord=record
      record.time.busy=Date.now()
      const user=store.append('user',body.text)
      if(typeof body.id==='string')user.id=body.id
      startReply(androidLive)
    },
    restartHistory() {
      assert.equal(phase,'reset')
      store.append('assistant','Mobile Rust restart history')
    },
    async command(action, http, directOrigin) {
      if (action === 'pair') {
        const response = await http.post('/api/remote-control/pairings',directOrigin?{data:{origin:directOrigin}}:undefined)
        assert(response.ok(),`Pairing ${response.status()}: ${await response.text()}`)
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
          startReply('Mobile live SSE only')
          break
        }
        case 'cut': {
          assert(streams.size)
          const retry=compare?new Promise(resolve=>{rejectedReconnect=resolve}):null
          held = true
          for (const stream of streams) stream.destroy()
          live.time.completed = Date.now()
          if(turnRecord)turnRecord.time.idle=Date.now()
          store.rows.push(live)
          store.append('assistant', 'Mobile recovered history')
          phase = 'resume'
          if(retry){
            let timer
            try {
              await Promise.race([retry,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('No rejected upstream SSE retry')),10000)})])
            } finally { clearTimeout(timer); rejectedReconnect=undefined }
          }
          break
        }
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
