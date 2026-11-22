// Native contract fixture only: no model, shell, file tool or user project is executed.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {textStream} from './fixture-response.mjs'
export function controlsFixture({records,stores,streams,project,stats}) {
  const session='ses_existing'
  const permissions=['once','always','reject'].map(decision=>({id:`per_${decision}`,sessionID:session,action:'read',resources:['synthetic.rs'],message:'Synthetic permission'}))
  const fields=[{key:'name',type:'string',required:true},{key:'count',type:'integer',required:true,minimum:1,maximum:4},
    {key:'enabled',type:'boolean',default:false},{key:'tags',type:'multiselect',required:true,options:[{value:'one',label:'One'},{value:'two',label:'Two'}]},
    {key:'detail',type:'string',required:true,when:[{key:'enabled',op:'eq',value:true}]},{key:'hidden',type:'string',hidden:true,default:'native-default'}]
  const forms=[{id:'form_answer',sessionID:session,title:'Synthetic typed question',fields},
    {id:'form_cancel',sessionID:session,title:'Cancel synthetic question',fields:[{key:'value',type:'string'}]}]
  const formDetails=new Map(forms.map(f=>[f.id,{...f,state:{status:'pending'}}]))
  const models=[{id:'fixture-model',providerID:'fixture',name:'Synthetic model',enabled:true,variants:[{id:'fast'}],headers:{Authorization:'fixture-never-render-this'}},
    {id:'disabled',providerID:'fixture',name:'Disabled',enabled:false}]
  let failed=false,slow=false,timer,liveText
  const emit=(type,data)=>{for(const stream of streams)stream.write(`data: ${JSON.stringify({id:randomUUID(),type,created:Date.now(),location:{directory:project},data})}\n\n`)}
  return {
    async route(req,url,raw,json,res){
      if(url.pathname==='/api/config'){json([{type:'directory',path:project}]);return true}
      if(url.pathname==='/api/model') {stats.modelReads=(stats.modelReads??0)+1;if(slow)await new Promise(r=>setTimeout(r,1500));json({location:{directory:project},data:models});return true}
      const match=url.pathname.match(/^\/api\/session\/([^/]+)\/(.*)$/);if(!match)return false
      const [,id,action]=match
      if(action==='prompt') {
        const record=records.get(id),store=stores.get(id),body=JSON.parse(raw)
        store.append('user',body.text);const reply=store.append('assistant','',false)
        record.time.busy=Date.now();stats.prompts++;slow=true
        emit('session.step.started',{sessionID:id,assistantMessageID:reply.id,agent:'fixture',model:{id:'fixture-model',providerID:'fixture'}})
        liveText=textStream(reply,(type,data)=>emit(type,{sessionID:id,...data}))
        json({data:{id:'inbox-controls'}})
        const form={id:'form_live',sessionID:id,title:'Live question',fields:[{key:'value',type:'string'}]};forms.push(form)
        for(let i=0;i<20;i++)emit('form.created',{form})
        timer=setInterval(()=>liveText.append('fragment '),80)
        return true
      }
      if(action==='permission'&&req.method==='GET'){json({data:id===session?permissions:[]});return true}
      if(action==='form'&&req.method==='GET'){json({data:id===session?forms:[]});return true}
      if(action.startsWith('permission/')&&req.method==='GET'){
        const pending=permissions.find(p=>p.id===action.split('/')[1]&&p.sessionID===id)
        if(!pending){res.statusCode=404;json({_tag:'PermissionNotFoundError',requestID:action.split('/')[1],message:'Permission is no longer pending for this session'})}
        else json({data:pending});return true
      }
      if(action.startsWith('form/')&&req.method==='GET'){
        const detail=formDetails.get(action.split('/')[1])
        if(!detail||detail.sessionID!==id){res.statusCode=404;json({_tag:'FormNotFoundError',id:action.split('/')[1],message:'Question is no longer pending for this session'})}
        else json({data:detail});return true
      }
      if(action==='model'&&req.method==='POST') {const body=JSON.parse(raw);records.get(id).model=body.model;stats.model=body.model;json({data:records.get(id)});return true}
      if(action.startsWith('permission/')&&action.endsWith('/reply')) {
        const request=action.split('/')[1],index=permissions.findIndex(p=>p.id===request&&p.sessionID===id)
        assert(index>=0,'server must reject stale/foreign permission before forwarding')
        if(request==='per_reject'&&!failed){failed=true;stats.permissionFailures=(stats.permissionFailures??0)+1;res.statusCode=503;json({error:'synthetic failure'});return true}
        const input=JSON.parse(raw);assert.equal(input.decision,request.slice(4));assert.equal(input.message,'kept reason')
        permissions.splice(index,1);(stats.decisions??=[]).push(input.decision)
        emit('permission.replied',{sessionID:id,requestID:request,reply:input.decision});json({data:{}});return true
      }
      if(action.startsWith('form/')) {
        const request=action.split('/')[1],index=forms.findIndex(f=>f.id===request&&f.sessionID===id)
        assert(index>=0,'server must reject stale/foreign form before forwarding')
        if(req.method==='POST') {const {answer}=JSON.parse(raw);assert.deepEqual(answer,{name:'Rune answer',count:2,enabled:true,tags:['one'],detail:'conditional answer',hidden:'native-default'});stats.answer=answer;formDetails.get(request).state={status:'answered',answer}}
        else {assert.equal(req.method,'DELETE');stats.cancelled=request;formDetails.get(request).state={status:'cancelled'}}
        forms.splice(index,1);emit(req.method==='DELETE'?'form.cancelled':'form.replied',{sessionID:id,id:request});json({data:{}});return true
      }
      if(action==='interrupt'){assert.deepEqual(JSON.parse(raw),{resume:false});records.get(id).time.idle=Date.now()+1;stats.interrupt=(stats.interrupt??0)+1;
        clearInterval(timer);liveText.close();slow=false;emit('session.execution.interrupted',{sessionID:id});json({data:{interrupted:true}});return true}
      if(action==='fixture-slow'){slow=true;json({data:{}});return true}
      return false
    },
    close(){clearInterval(timer)},
    done(){assert.deepEqual(stats.decisions,['once','always','reject']);assert.equal(stats.permissionFailures,1);assert.equal(stats.cancelled,'form_cancel');assert.equal(stats.interrupt,1);assert.equal(stats.model.variant,'fast');assert(stats.modelReads<=6,'event refreshes must coalesce')}
  }
}
