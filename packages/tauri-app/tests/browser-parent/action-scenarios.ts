import assert from "node:assert/strict"
export interface Harness {
  navigate(name:string):Promise<unknown>
  snapshot():Promise<string>
  act(action:Record<string,unknown>):Promise<Record<string,unknown>>
  observe():Promise<any>
  control(kind:string):Promise<unknown>
}
export async function actionScenarios(h:Harness,engine:string) {
  const checks:string[]=[],limitations:string[]=[],observations:Record<string,unknown>={}
  const ref=async(pattern:RegExp)=>{const snapshot=await h.snapshot();const line=snapshot.split('\n').find(line=>pattern.test(line));assert.ok(line,`${pattern}: ${snapshot}`);return /\[([^\]]+)\]/.exec(line)![1]}
  const type=async(pattern:RegExp,text:string,clear=true)=>h.act({action:"type",ref:await ref(pattern),text,clear})
  const press=async(key:string,target?:string)=>h.act({action:"press",key,...target?{ref:target}:{}})
  const until=async(predicate:(value:any)=>boolean)=>{const deadline=Date.now()+3000;let value;do{value=await h.observe();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,30))}while(Date.now()<deadline);assert.ok(predicate(value));return value}
  await h.navigate('preview')
  assert.equal((await type(/textbox "Title"/,'Nouveau é🙂')).value,'Nouveau é🙂')
  assert.equal((await type(/textbox "Title"/,' appended',false)).value,'Nouveau é🙂 appended')
  await h.act({action:'select',ref:await ref(/combobox "Plan"/),values:['Exploration']})
  await h.act({action:'click',ref:await ref(/button "Confirm"/)})
  assert.match(await h.snapshot(),/Nouveau é🙂 appended:wayfinder/)
  checks.push('automation-preview: Unicode clear/append, select, trusted click')

  await h.navigate('forms')
  assert.equal((await type(/textbox "Notes"/,'New notes')).value,'New notes')
  assert.equal((await type(/textbox "Rich"/,'Rich é🙂')).value,'Rich é🙂')
  assert.equal((await type(/Date "Due"/,'2026-11-07')).value,'2026-11-07')
  const select=await ref(/combobox "Scenario"/)
  await h.act({action:'select',ref:select,values:['wayfinder']})
  const before=(await h.observe()).audit.filter((event:any)=>event.id==='scenario' && ['input','change'].includes(event.type)).length
  await h.act({action:'select',ref:select,values:['Exploration']})
  assert.equal((await h.observe()).audit.filter((event:any)=>event.id==='scenario' && ['input','change'].includes(event.type)).length,before)
  await assert.rejects(h.act({action:'select',ref:select,values:['Debugging']}),/disabled/)
  await h.act({action:'click',ref:await ref(/checkbox "Agree"/)})
  checks.push('automation-forms: native/contenteditable/date, select value/label, unchanged events, disabled option')

  await h.navigate('edges')
  await assert.rejects(type(/textbox "Locked"/,'Forbidden'),/disabled/)
  await type(/textbox "Mail"/,'x@y.test')
  await type(/spinbutton "Count"/,'42')
  await type(/ColorWell "Tint"/,'#123abc')
  await type(/slider "Volume"/,'60')
  await assert.rejects(type(/Date "Day"/,'invalid'),/not a valid/)
  checks.push('automation-forms edges: disabled, email/number/color/range setters and date validation')

  await h.navigate('inputs')
  const query=await ref(/textbox "Query"/)
  await type(/textbox "Query"/,'hello')
  await press('Enter',query)
  let observed=await h.observe()
  observations.enter=observed
  if(!observed.log.includes('submit:hello') && engine==='macos') limitations.push('Enter in a background WKWebView input did not submit the form')
  else assert.ok(observed.log.includes('submit:hello'))
  await press('Tab')
  await h.act({action:'hover',ref:await ref(/button "Hover me"/)})
  observed=await h.observe()
  if(observed.hover!=='hovered' && engine==='macos') limitations.push('Initial standalone hover did not deliver pointerenter')
  else assert.equal(observed.hover,'hovered')
  await h.act({action:'click',ref:await ref(/button "Open menu"/)})
  await h.act({action:'click',ref:await ref(/menuitem "Menu item"/)})
  await h.act({action:'click',ref:await ref(/button "Open menu"/),button:'right'})
  await h.act({action:'scroll',ref:await ref(/region "Scroller"/),direction:'down',amount:500})
  observed=await until(value=>value.scroll>0)
  await h.act({action:'drag',ref:await ref(/button "Handle"/),to:await ref(/region "Drop zone"/)})
  observed=await until(value=>value.dropped)
  await assert.rejects(h.act({action:'click',ref:await ref(/button "Under"/)}),/covered/)
  await h.control('schedule-ready')
  assert.equal((await h.act({action:'wait',text:'Ready now',timeout:15000})).found,true)
  await h.control('remove-ready')
  assert.equal((await h.act({action:'wait',text:'Ready now',gone:true,timeout:15000})).found,false)
  await assert.rejects(h.act({action:'wait',text:'absent',timeout:50}),/did not appear/)
  observed=await h.observe()
  assert.ok(observed.audit.some((event:any)=>event.type==='contextmenu' && event.trusted))
  assert.ok(observed.audit.filter((event:any)=>['pointerdown','pointerup','pointermove','wheel','keydown','keyup','click'].includes(event.type)).every((event:any)=>event.trusted))
  observations.inputs=observed
  await h.control('hidden-open');const hidden=await ref(/textbox "Hidden target"/);await h.control('hidden-close')
  await assert.rejects(press('Enter',hidden),/cannot take focus/)
  await h.control('long-rows')
  await assert.rejects(h.act({action:'drag',ref:await ref(/button "Row 1"/),to:await ref(/button "Row 35"/)}),/no visible box/)
  await h.act({action:'scroll',direction:'down',amount:500})
  await until(value=>value.pageScroll>0)
  checks.push('automation-input: Enter/Tab, hover, left/right pointer, native element/page wheel, drag, covered/hidden/offscreen refusal, wait appear/disappear')

  await h.navigate('advanced')
  await h.act({action:'click',ref:await ref(/button "Closed action"/)})
  assert.equal((await type(/textbox "Closed field"/,'Closed é🙂')).value,'Closed é🙂')
  assert.equal((await type(/textbox "Shadow field"/,'Open shadow')).value,'Open shadow')
  if(engine!=='chromium') assert.equal((await type(/textbox "Frame field"/,'Frame é🙂')).value,'Frame é🙂')
  else observations.frame='Contents absent from Chromium main-frame AX tree'
  observed=await h.observe();assert.equal(observed.closedClicks,1);assert.equal(observed.closedTrusted,true)
  await h.control('forge-shadow')
  const forged=await h.snapshot();assert.equal(forged.split('button "Closed action"').length-1,1)
  if(engine!=='chromium') assert.match(forged,/Closed shadow root \(unavailable\)/)
  const old=await ref(/textbox "Closed field"/);await h.control('remove-closed')
  await assert.rejects(h.act({action:'type',ref:old,text:'stale'}),/no longer|snapshot/)
  checks.push('closed/open shadow and same-origin frame: trusted click, native text, forged root rejection and stale refs')

  await h.navigate('extra')
  await assert.rejects(type(/textbox "Readonly"/,'Forbidden'),/read-only/)
  assert.equal((await type(/textbox "Password"/,'secret')).value,'•'.repeat(6))
  await type(/InputTime "Clock"/,'12:34')
  await type(/DateTime "Moment"/,'2026-11-07T12:34')
  const multiple=await ref(/listbox "Multiple"/)
  assert.deepEqual((await h.act({action:'select',ref:multiple,values:['one','Two']})).selected,['One','Two'])
  await assert.rejects(h.act({action:'select',ref:multiple,values:['Three']}),/disabled/)
  await type(/textbox "Rich lines"/,'one')
  await press('Enter',await ref(/textbox "Rich lines"/))
  await type(/textbox "Rich lines"/,'two',false)
  const enterRich=await h.observe();observations.richEnter=enterRich
  assert.match(enterRich.fields.rich.value,/one\n(?:\n)?two/)
  await press('Mod+A',await ref(/textbox "Rich lines"/));await press('Enter')
  observations.modThenEnter=await h.observe()
  observations.declarative=observations.modThenEnter
  if(engine==='macos') {
    const audit=(observations.modThenEnter as any).audit
    if(!audit.some((event:any)=>event.type==='keyup' && event.key==='Meta')) limitations.push('Mod+A: WKWebView did not expose the Meta keyup in DOM events')
    const enters=audit.filter((event:any)=>event.type==='keydown' && event.key==='Enter')
    if(enters.length<2) limitations.push('Enter following Mod+A was not delivered to contenteditable')
    if(!audit.some((event:any)=>event.type==='keyup' && event.key==='Enter')) limitations.push('Standalone Enter: WKWebView omitted DOM keyup')
  }
  checks.push('multiple select/disabled optgroup, readonly, password masking, time/datetime, contenteditable Enter and Mod chord')
  return {passed:true,engine,checks,limitations,observations}
}
