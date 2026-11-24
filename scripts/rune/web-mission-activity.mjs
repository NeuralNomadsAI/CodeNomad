import assert from 'node:assert/strict'

export function actorWindow(missionID,revision,order,runState){
  return {
    context:{id:missionID,projectID:'fixture-project',revision,status:'active',
      ...(runState?{runState}:{}),
      coordinatorSessionId:'ses_existing',
      actors:[{sessionId:'ses_actor',title:'Acteur observé 🦀',location:{directory:'/fixture'},reportOwed:true,callOpen:false}],
      actorPage:{order,offset:0,end:1,total:1},
      discardedEvents:0,controlUnavailable:false,notificationUnavailable:false,cleanupUnavailable:false},
    coverage:'partial',
    requests:{state:'partial',items:[{kind:'form',actorSessionId:'ses_actor',
      request:{id:'form',sessionID:'ses_child',title:'Question privée',fields:[]}}]},
    activity:{actors:[{sessionId:'ses_actor',state:'running'}],
      family:{state:'partial',members:[{sessionId:'ses_child',actorSessionId:'ses_actor',parentSessionId:'ses_actor',kind:'ordinary'}]}},
  }
}

export async function assertActorActivity(page,messages){
  const name=messages['missions.control.activity.title']
  const activity=page.getByRole('region',{name,exact:true})
  const actor=activity.getByRole('listitem',{name:'Acteur observé 🦀',exact:true})
  await actor.getByText(messages['missions.control.activity.state.form'],{exact:true}).waitFor()
  assert.equal(await activity.getByText('Question privée',{exact:true}).count(),0,'The panel displays a request state, not its prompt')
}
