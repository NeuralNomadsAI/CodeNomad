// One native request sequence through both backends, with independently isolated daemons.
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
export const holdProvider='BENCH-AGENT-CONTROLS-HOLD'
const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
async function eventually(check,label){for(const end=Date.now()+20000;Date.now()<end;await delay(50)){const value=await check();if(value)return value}throw Error(`Timed out: ${label}`)}
export async function run({call,fixture,folder,other}){
  const read=async(route,init)=>{const r=await call(route,{...init,signal:AbortSignal.timeout(30000)});const raw=await r.text();return {status:r.status,body:raw?JSON.parse(raw):null}}
  const opened=await read('/api/workspaces',post({path:folder}));assert.equal(opened.status,201)
  const workspace=opened.body,location={directory:workspace.location.directory},prefix=`/workspaces/${workspace.id}/instance/api/session`
  const native=fixture.client,session=await native.session.create({location,title:'Agent controls bench',permissions:[{action:'*',resource:'*',effect:'deny'},{action:'bench.permission',resource:'*',effect:'ask'}]})
  const out={decisions:[],refusals:{},forms:{},interrupt:{}}
  try {
    for(const decision of ['once','always','reject']){
      const id=`per_bench_${decision}`,created=await native.permission.create({sessionID:session.id,id,agent:'build',action:'bench.permission',resources:[`synthetic-${decision}`]})
      assert.equal(created.effect,'ask')
      await eventually(async()=> (await native.permission.list({sessionID:session.id})).some(p=>p.id===id),'native pending permission')
      const response=await read(`${prefix}/${session.id}/permission/${id}/reply`,post({decision,message:`reason-${decision}`}));assert.equal(response.status,204)
      assert.equal((await native.permission.list({sessionID:session.id})).some(p=>p.id===id),false)
      out.decisions.push({decision,status:response.status})
    }
    const receipts=await eventually(async()=>{const r=await read(`/api/workspaces/${workspace.id}/sessions/${session.id}/permission-receipts?unanchored=true`);return r.body?.receipts?.length===3?r.body.receipts:undefined},'confirmed receipts')
    out.receipts=receipts.map(r=>({decision:r.decision,origin:r.origin,reason:r.reason,resources:r.resources})).sort((a,b)=>a.decision.localeCompare(b.decision))
    assert.deepEqual(out.receipts, ['always','once','reject'].map(decision => ({
      decision,origin:'codenomad',reason:`reason-${decision}`,resources:[`synthetic-${decision}`],
    })))
    const invalid = (message) => ({status:400,body:{error:message,message}})
    const refuse = async (key, route, init, expected) => {
      const response = await read(`${prefix}/${session.id}/${route}`, init)
      assert.deepEqual(response, expected, key)
      out.refusals[key] = response
    }
    for(const [key,body] of [['invalidDecision',{decision:'allow'}],['nonStringDecision',{decision:['once']}],['invalidMessage',{decision:'reject',message:17}],['longMessage',{decision:'once',message:'💡'.repeat(2049)}],['extraPermissionField',{decision:'once',extra:true}]]){
      await refuse(key, 'permission/per_absent/reply', post(body), invalid('Invalid permission decision'))
    }
    await refuse('stalePermission', 'permission/per_bench_once/reply', post({decision:'once'}), {status:404,body:{
      _tag:'PermissionNotFoundError',requestID:'per_bench_once',message:'Permission is no longer pending for this session',
    }})
    const question=await native.session.form.create({sessionID:session.id,title:'Typed question',fields:[{key:'name',type:'string',required:true},{key:'count',type:'integer',minimum:1,maximum:4},{key:'enabled',type:'boolean'}]})
    const answer={name:'Native answer',count:2,enabled:true}
    await refuse('extraReplyField', `form/${question.id}/reply`, post({answer,extra:true}), invalid('Invalid question request'))
    out.forms.answer=(await read(`${prefix}/${session.id}/form/${question.id}/reply`,post({answer}))).status
    const detail=await native.session.form.get({sessionID:session.id,formID:question.id});assert.equal(detail.state.status,'answered');assert.deepEqual(detail.state.answer,answer)
    out.forms.state=detail.state
    const missingQuestion = await read(`${prefix}/${session.id}/form/frm_absent`, {method:'DELETE'})
    assert.deepEqual(missingQuestion, {status:404,body:{_tag:'FormNotFoundError',id:'frm_absent',message:'Question is no longer pending for this session'}})
    out.refusals.missingForm = missingQuestion.status
    const cancel=await native.session.form.create({sessionID:session.id,title:'Cancel question',fields:[{key:'value',type:'string'}]})
    const sibling=await native.session.create({location,title:'Other session in the same workspace'})
    const wrong=await read(`${prefix}/${sibling.id}/form/${cancel.id}`,{method:'DELETE'})
    assert.deepEqual(wrong,{status:404,body:{_tag:'FormNotFoundError',id:cancel.id,message:'Question is no longer pending for this session'}})
    out.refusals.otherSessionForm=wrong.status
    await refuse('extraCancelField', `form/${cancel.id}`, {...post({extra:true}),method:'DELETE'}, invalid('Invalid question request'))
    out.forms.cancel=(await read(`${prefix}/${session.id}/form/${cancel.id}`,{method:'DELETE'})).status
    out.forms.cancelled=(await native.session.form.get({sessionID:session.id,formID:cancel.id})).state.status
    const settled = await read(`${prefix}/${session.id}/form/${cancel.id}`,{method:'DELETE'})
    assert.deepEqual(settled, {status:409,body:{_tag:'FormAlreadySettledError',id:cancel.id,message:'Question is no longer pending for this session'}})
    out.refusals.staleForm = {status:settled.status,tag:settled.body._tag}
    await refuse('invalidInterrupt', 'interrupt?resume=no', {method:'POST'}, invalid('Invalid interruption request'))
    await refuse('duplicateResume', 'interrupt?resume=false&resume=true', {method:'POST'}, invalid('Invalid interruption request'))
    await refuse('extraInterruptField', 'interrupt', post({resume:false,extra:true}), invalid('Invalid interruption request'))
    const foreign=await native.session.create({location:{directory:other},title:'Foreign controls bench'})
    out.refusals.foreignInterrupt=(await read(`${prefix}/${foreign.id}/interrupt?resume=false`,{method:'POST'})).status
    assert.equal(out.refusals.foreignInterrupt,403)
    const started=await read(`${prefix}/${session.id}/prompt`,post({text:holdProvider}));assert.equal(started.status,200)
    await eventually(async()=> (await native.session.active())[session.id],'native active execution')
    const stopped=await read(`${prefix}/${session.id}/interrupt?resume=false`,{method:'POST'});assert.equal(stopped.status,200)
    out.interrupt.status=stopped.status;out.interrupt.result=stopped.body
    await eventually(async()=>!(await native.session.active())[session.id],'native idle after interruption')
    out.interrupt.outcome=(await native.session.get({sessionID:session.id})).outcome
    assert.equal(out.interrupt.outcome,'interrupted')
    out.interrupt.idle=[]
    for (const suffix of ['', '?resume=true']) {
      const idle=await read(`${prefix}/${session.id}/interrupt${suffix}`,{method:'POST'})
      assert.equal(idle.status,200)
      out.interrupt.idle.push(idle.body)
    }
    return out
  } finally {await call(`/api/workspaces/${workspace.id}`,{method:'DELETE'})}
}
