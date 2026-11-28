import assert from 'node:assert/strict'

export async function markerFilters(page, messages, url, project, {touch, pages, attestedPatch}) {
  assert(typeof attestedPatch==='function','Attested PATCH helper required for markerFilters')
  const rail=page.getByRole('navigation',{name:messages['messageTimeline.ariaLabel']})
  const reason=rail.getByRole('button',{name:messages['messageBlock.reasoning.thinkingLabel'],exact:true})
  const tool=rail.getByRole('button',{name:'read',exact:true})
  const system=rail.getByRole('button',{name:messages['messageBlock.system.label'],exact:true})
  const compact=rail.getByRole('button',{name:messages['messageTimeline.segment.compaction.label'],exact:true})
  const title=messages['transcriptFilters.title']
  const thinking=messages['settings.behavior.expansionDefaults.thinking']
  const name=key=>messages[`transcriptFilters.${key}`].replace('{name}',thinking)
  const button=label=>page.getByRole('button',{name:label,exact:true})
  const press=async locator=>{
    await locator.waitFor()
    const box=await locator.boundingBox()
    assert(box)
    const [x,y]=[box.x+box.width/2,box.y+box.height/2]
    if(touch)await page.touchscreen.tap(x,y)
    else await page.mouse.click(x,y)
  }
  const top=async()=>{
    const box=await rail.boundingBox()
    assert(box)
    await page.mouse.move(box.x+box.width/3,box.y+12)
    await page.mouse.wheel(0,-100000)
    await tool.waitFor()
    await reason.first().waitFor()
    await system.waitFor()
  }
  const update=async(show, everything=true)=>{
    const settings={showThinkingBlocks:show}
    if(everything)Object.assign(settings,{systemMessagesVisibility:show?'expanded':'hidden',
      toolCallExpansionDefaults:{tools:{read:show?'expanded':'hidden'}}})
    const response=await attestedPatch('/api/storage/config/ui',{settings})
    assert(response.ok,`The private fixture can save transcript visibility (status ${response.status})`)
  }
  const before=page.viewportSize()
  const closed=[]
  if(touch){
    await page.setViewportSize({width:390,height:844})
    await rail.waitFor({state:'detached'})
    await page.setViewportSize({width:844,height:390})
    for(const label of ['window.menu.leftPanel','window.menu.rightPanel']){
      const toggle=button(messages[label])
      if(await toggle.getAttribute('aria-expanded')==='true'){
        await press(toggle)
        closed.push(toggle)
      }
    }
  }
  try{
    await rail.waitFor()
    await top()
    const count=pages()
    await press(button(title))
    const popup=page.getByRole('dialog',{name:title})
    await popup.waitFor()
    const shown=popup.getByRole('button',{name:name('hide'),exact:true})
    await shown.waitFor()
    // App focus is on the canvas; walk real Tab stops to the visibility button.
    const focusedLabel=()=>page.evaluate(()=>{
      const key=document.querySelector('canvas')?.getAttribute('aria-activedescendant')
      return key?document.getElementById(key)?.getAttribute('aria-label'):null
    })
    for(let n=0;n<12&&await focusedLabel()!==name('hide');n++)await page.keyboard.press('Tab')
    assert.equal(await focusedLabel(),name('hide'))
    const saved=page.waitForResponse(res=>res.ok()&&res.url().endsWith('/api/storage/config/ui')&&res.request().method()==='PATCH')
    await page.keyboard.press('Enter')
    await saved
    await popup.getByRole('button',{name:name('show'),exact:true}).waitFor()
    await page.keyboard.press('Escape')
    await popup.waitFor({state:'detached'})
    await reason.first().waitFor({state:'detached'})
    assert.equal(pages(),count,'Keyboard filters must not page the transcript')
    await update(true,false)
    await reason.first().waitFor()
    if(!touch){
      const tab=page.getByRole('tab',{name:project,exact:true})
      await press(button(messages['instanceTabs.new.ariaLabel']))
      const blank=page.getByRole('tab',{name:messages['instanceTabs.new.ariaLabel'],exact:true})
      await blank.and(page.locator('[aria-selected="true"]')).waitFor()
      await update(false)
      await press(tab)
      await tab.and(page.locator('[aria-selected="true"]')).waitFor()
      await rail.waitFor()
      const box=await rail.boundingBox()
      assert(box)
      await page.mouse.move(box.x+10,box.y+10)
      await page.mouse.wheel(0,-100000)
      await compact.waitFor()
      await tool.waitFor({state:'detached'})
      await system.waitFor({state:'detached'})
      assert.equal(await reason.count(),0,'The existing tab must reflect filters saved while it was inactive')
    }
  }finally{
    await update(true)
    if(touch){
      await page.setViewportSize(before)
      await page.waitForFunction(({width,height})=>{
        const canvas=document.querySelector('canvas')?.getBoundingClientRect()
        return canvas&&Math.abs(canvas.width-width)<=1&&Math.abs(canvas.height-height)<=1
      },before)
      for(const toggle of closed)await press(toggle)
    }
  }
}
