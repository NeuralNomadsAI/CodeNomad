import assert from 'node:assert/strict'

export function seedHistory({stores,webTimeline,webMobile,webAndroid,webSearch}) {
  const store=stores.get('ses_existing')
  if(webTimeline){
    store.append('assistant','Lead before the anchor').content.push(
      {type:'reasoning',text:'First fixture reasoning'},
      {type:'tool',id:'timeline-anchor',name:'read',state:{status:'completed',input:{file:'timeline.txt'},content:[{type:'text',text:'Tool output'}]}},
      {type:'text',text:'Exact position in the old message'},
      {type:'reasoning',text:'**Second fixture reasoning**'},
    )
    store.rows.push(
      {id:'timeline-compaction',type:'compaction',reason:'auto',status:'completed',summary:'Native compacted passage',time:{created:2,completed:3}},
      {id:'timeline-system',type:'system',text:'Native conversation context',time:{created:4}},
    )
    for(let i=0;i<220;i++)store.append('assistant',`Fixture passage ${i}`)
  }
  if(webMobile)for(let i=0;i<(webAndroid?70:210);i++)store.append('assistant',`Mobile history row ${i}`)
  store.append('user','Existing project history')
  store.append('assistant','Existing answer')
  if(webSearch){
    store.append('assistant','Technical search fixture').content.push(
      {type:'tool',id:'search-tool',name:'grep',state:{status:'completed',content:[{type:'text',text:'Found Existing technical tool match'}]}},
      {type:'tool',id:'neighbor',name:'read',state:{status:'completed',content:[{type:'text',text:'Other tool output'}]}},
    )
    store.append('assistant','Reasoning search fixture').content.push({type:'reasoning',text:'Existing reasoning match in the opened card'})
    store.append('assistant','Arguments fixture').content.push(
      {type:'tool',id:'search-input',name:'grep',state:{status:'completed',input:{extra:'Existing arguments only'},content:[{type:'text',text:'No match here'}]}},
    )
    const another=stores.get('ses_another')
    const hit=another.append('user','Existing ranked destination\n\nStored preview detail')
    hit.time.created-=2*60*60*1000
    another.append('assistant','Remote tool fixture').content.push(
      {type:'tool',id:'remote-tool',name:'grep',state:{status:'completed',content:[{type:'text',text:'Existing remote tool match'}]}},
    )
  }
}

export function historyResponse(pathname, raw, {stores,records,project,linked,directory,webSearch,webTouchHistory,webOutline,compare}) {
  const prefix='/api/rpc/codenomad.session-pruning/'
  if(!pathname.startsWith(prefix))return
  const method=pathname.slice(prefix.length)
  if(webSearch&&method==='history'){
    const {input}=JSON.parse(raw)
    assert.deepEqual(input,{sessionID:'ses_existing',query:'Existing',purpose:'search',includeTechnical:input.includeTechnical})
    const hits=[{messageID:'message-00001',partIndex:0,kind:'text',excerpt:'Existing answer'}]
    if(input.includeTechnical)hits.push(
      {messageID:'message-00002',partIndex:1,kind:'tool',excerpt:'Existing technical tool match'},
      {messageID:'message-00003',partIndex:1,kind:'reasoning',excerpt:'Existing reasoning match'},
      {messageID:'message-00004',partIndex:1,kind:'tool',excerpt:'Existing arguments only'},
    )
    return {output:{status:'page',scanned:5,tools:0,reasoning:0,skipped:0,
      hits:hits.map(hit=>({sessionID:input.sessionID,role:'assistant',...hit})),candidates:[],cursor:null,
      sessions:[{sessionID:input.sessionID,directory:project,scanned:5,tools:0,reasoning:0,skipped:0}]}}
  }
  if(webSearch&&method==='historyRanked'){
    const {input}=JSON.parse(raw)
    assert.equal(input.query,'Existing')
    const shape=(sessionID,index,excerpt,kind='text',partIndex=0)=>({sessionID,messageID:stores.get(sessionID).rows[index].id,
      role:'assistant',partIndex,kind,excerpt,createdAt:100})
    const continued=input.cursor!==undefined
    if(continued)assert.equal(input.cursor,'fixture-ranked-continuation')
    assert(directory===project||directory===linked)
    const hits=directory===linked?[shape('ses_another',0,'Existing ranked destination')]:
      [shape('ses_existing',1,continued?'Existing older result':'Existing answer')]
    if(input.includeTechnical&&directory===linked)hits.push(shape('ses_another',1,'Existing remote tool match','tool',1))
    const sessions=hits.filter(({sessionID},i)=>i===hits.findIndex(hit=>hit.sessionID===sessionID)).map(({sessionID})=>{
      const count=hits.filter(hit=>hit.sessionID===sessionID).length
      return {sessionID,directory,title:records.get(sessionID).title,scanned:count,candidates:count,
        judged:count,matchedMessages:count,tools:0,reasoning:0,skipped:0,prefilterBypassed:0}
    })
    return {output:{version:1,status:'ranked',scanned:hits.length,candidates:hits.length,judged:hits.length,skipped:0,prefilterBypassed:0,
      matchedSessions:sessions.length,capped:false,examinedBefore:0,cursor:continued||directory===linked?null:'fixture-ranked-continuation',exclusions:[],caps:[],hits,sessions}}
  }
  if(method==='outlinePreview'){
    const {input}=JSON.parse(raw), rows=stores.get(input.sessionID).rows
    assert(input.messageIDs.length>0&&input.messageIDs.length<=12)
    assert.equal(new Set(input.messageIDs).size,input.messageIDs.length)
    return {output:{status:'previews',entries:input.messageIDs.filter(id=>rows.some(row=>row.id===id))
      .map(id=>({id,text:`**Indexed excerpt ${id}**`,tools:`**Indexed tool excerpt ${id}**${id==='message-00000'
        ? '\n\n'+('Additional visible text.\n\n'.repeat(25))+'Final `token`' : ''}`}))}}
  }
  if(method==='outlineLayout'){
    const {input}=JSON.parse(raw),rows=stores.get(input.sessionID).rows
    assert(!input.cursor)
    const entries=rows.map((row,seq)=>({
      id:row.id,seq,type:row.type,
      tools:row.content?.filter(part=>part.type==='tool').length??0,
      reasoning:row.content?.filter(part=>part.type==='reasoning').length??0,
      ...(row.type==='assistant'?{
        text:row.content.filter(part=>part.type==='text').length,
        layout:row.content.map(part=>part.type==='tool'?'X':part.type==='reasoning'?'R':'T').join(''),
        ...(row.content.some(part=>part.type==='tool')?{toolName:row.content.find(part=>part.type==='tool').name}:{}),
      }:{}),
    }))
    if(webOutline&&rows.length>24){
      const head={after:-1,through:23,digest:'a'.repeat(64)}
      const tail={after:23,through:rows.length-1,digest:'b'.repeat(64),changed:true}
      const unchanged=input.known?.some(c=>c.after===head.after&&c.through===head.through&&c.digest===head.digest)??false
      return {output:{status:'outline',entries:unchanged?entries.slice(24):entries,
        total:entries.length,cursor:null,checkpoints:[{...head,changed:!unchanged},tail]}}
    }
    const through=Math.max(0,rows.length-1)
    return {output:{status:'outline',entries,total:rows.length,cursor:null,
      checkpoints:rows.length?[{after:-1,through,digest:'a'.repeat(64),changed:true}]:[]}}
  }
  if(method==='window'||method==='windowUserFilesV1'){
    const {input}=JSON.parse(raw),output=stores.get(input.sessionID).window(input.target)
    if(webTouchHistory&&input.sessionID==='ses_existing'&&input.target.kind==='latest'&&output.status==='window'){
      output.messages=output.messages.slice(-8)
      output.older={kind:'before',messageID:output.messages[0].id}
    }
    if(method==='windowUserFilesV1'&&output.status==='window')output.userFiles='reference-v1'
    return {output}
  }
  if(compare&&method==='outline'){
    const {input}=JSON.parse(raw),rows=stores.get(input.sessionID).rows
    return {output:{status:'outline',entries:rows.map(({id,type},seq)=>({id,type,seq,tools:0,reasoning:0,text:1})),
      total:rows.length,cursor:null,checkpoints:[]}}
  }
}

export function historyPreview(store,action){
  const row=store.rows.find(row=>row.id===action.split('/')[1])
  assert(row,'preview requests exactly one known history row')
  return {data:row}
}
