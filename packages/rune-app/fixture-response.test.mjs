import assert from 'node:assert/strict'
import test from 'node:test'
import {textStream} from './fixture-response.mjs'

test('native fixture starts before deltas, closes with full text and persisted provenance',()=>{
  const row={id:'reply-1',content:[{type:'text',text:''}]},events=[]
  const stream=textStream(row,(type,data)=>events.push({type,...data}))
  stream.append('fn ');stream.append('main')
  assert.equal(row.content[0].native,undefined)
  stream.close()
  assert.deepEqual(events.map(e=>e.type),['session.text.started','session.text.delta','session.text.delta','session.text.ended'])
  assert(events.every(e=>e.assistantMessageID==='reply-1'&&e.ordinal===0))
  assert.equal(events.at(-1).text,'fn main')
  assert.deepEqual(row.content[0],{type:'text',text:'fn main',native:{itemID:'reply-1-text-0'}})
  assert.throws(()=>stream.append('late'));assert.throws(()=>stream.close())
})

test('text ordinal follows native text count independently of tools',()=>{
  const row={id:'reply-2',content:[{type:'text',text:''}]},events=[]
  const emit=(type,data)=>events.push({type,...data})
  const before=textStream(row,emit);before.append('prelude');before.close()
  row.content.push({type:'tool',id:'read',state:{status:'completed'}})
  const after=textStream(row,emit,1);after.append('fn main');after.close()
  assert.equal(row.content[2].text,'fn main')
  assert.deepEqual(events.filter(e=>e.type==='session.text.started').map(e=>e.ordinal),[0,1])
  assert.throws(()=>textStream(row,emit,3))
})
