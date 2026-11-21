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
    for(const [key,body] of [['invalidDecision',{decision:'allow'}],['invalidMessage',{decision:'reject',message:17}],['longMessage',{decision:'once',message:'x'.repeat(4097)}],['extraPermissionField',{decision:'once',extra:true}]]){
      out.refusals[key]=(await read(`${prefix}/${session.id}/permission/per_absent/reply`,post(body))).status
    }
    out.refusals.stalePermission=(await read(`${prefix}/${session.id}/permission/per_absent/reply`,post({decision:'once'}))).status
    const question=await native.session.form.create({sessionID:session.id,title:'Typed question',fields:[{key:'name',type:'string',required:true},{key:'count',type:'integer',minimum:1,maximum:4},{key:'enabled',type:'boolean'}]})
    const answer={name:'Native answer',count:2,enabled:true}
    out.forms.answer=(await read(`${prefix}/${session.id}/form/${question.id}/reply`,post({answer}))).status
    const detail=await native.session.form.get({sessionID:session.id,formID:question.id});assert.equal(detail.state.status,'answered');assert.deepEqual(detail.state.answer,answer)
    out.forms.state=detail.state
    const cancel=await native.session.form.create({sessionID:session.id,title:'Cancel question',fields:[{key:'value',type:'string'}]})
    out.forms.cancel=(await read(`${prefix}/${session.id}/form/${cancel.id}`,{method:'DELETE'})).status
    out.forms.cancelled=(await native.session.form.get({sessionID:session.id,formID:cancel.id})).state.status
    out.refusals.staleForm=(await read(`${prefix}/${session.id}/form/${cancel.id}`,{method:'DELETE'})).status
    out.refusals.invalidInterrupt=(await read(`${prefix}/${session.id}/interrupt`,post({resume:'no'}))).status
    out.refusals.extraInterruptField=(await read(`${prefix}/${session.id}/interrupt`,post({resume:false,extra:true}))).status
    const foreign=await native.session.create({location:{directory:other},title:'Foreign controls bench'})
    out.refusals.foreignInterrupt=(await read(`${prefix}/${foreign.id}/interrupt`,post({resume:false}))).status
    const started=await read(`${prefix}/${session.id}/prompt`,post({text:holdProvider}));assert.equal(started.status,200)
    await eventually(async()=> (await native.session.active())[session.id],'native active execution')
    const stopped=await read(`${prefix}/${session.id}/interrupt`,post({resume:false}));assert.equal(stopped.status,200)
    out.interrupt.status=stopped.status;out.interrupt.result=stopped.body
    await eventually(async()=>!(await native.session.active())[session.id],'native idle after interruption')
    out.interrupt.outcome=(await native.session.get({sessionID:session.id})).outcome
    assert.equal(out.interrupt.outcome,'interrupted')
    out.interrupt.idle=(await read(`${prefix}/${session.id}/interrupt`,post({resume:false}))).body
    return out
  } finally {await call(`/api/workspaces/${workspace.id}`,{method:'DELETE'})}
}
