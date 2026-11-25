import assert from 'node:assert/strict'

export async function chromeMemory(run,cdp) {
  const {stdout}=await run('shell','ps','-A','-o','PID,NAME')
  const chrome=[...stdout.matchAll(/^\s*(\d+)\s+(com\.android\.chrome(?::\S+)?)\s*$/gm)]
  assert(chrome.length,'No Chrome processes on the owned emulator')
  const processes=[]
  for(const [,pid,name] of chrome){
    const {stdout}=await run('shell','dumpsys','-t','5','meminfo','-s',pid)
    const pss=stdout.match(/TOTAL PSS:\s*(\d+)/)
    if(pss)processes.push({pid:Number(pid),name,pssKiB:Number(pss[1])})
  }
  assert(processes.some(row=>row.name==='com.android.chrome'),'Chrome main-process PSS missing')
  const {metrics}=await cdp.send('Performance.getMetrics')
  return {pssKiB:processes.reduce((total,row)=>total+row.pssKiB,0),observedProcesses:chrome.length,processes,
    jsHeapUsedBytes:metrics.find(row=>row.name==='JSHeapUsedSize')?.value}
}

export async function scrollMeasure(page,swipe,selector='[data-rune-a11y] p') {
  const sample=()=>page.evaluate(selector=>{
    const viewport=visualViewport.height
    return [...document.querySelectorAll(selector)]
      .filter(el=>el.textContent.startsWith('Mobile history row '))
      .map(el=>[el.textContent,Math.round(el.getBoundingClientRect().top)])
      .filter(([,y])=>y>=130&&y<viewport-180)
  },selector)
  const before=await sample()
  assert(before.length,'The private transcript must be painted before measuring scroll')
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(now=>{
    const samples=[]
    let last=now
    const controller=new AbortController()
    const state=globalThis.__runeAndroidScroll={samples,stop:false,controller}
    document.addEventListener('touchstart',event=>{
      state.start=event.timeStamp
      const transcript=event.target.closest?.('.message-stream')
      state.point={x:event.touches[0].clientX,y:event.touches[0].clientY,
        transcript:Boolean(transcript),tag:event.target.tagName,
        ...(transcript?{top:transcript.scrollTop,extent:transcript.scrollHeight-transcript.clientHeight}:{}),
      }
      if(globalThis.__runeAndroidTracing)performance.mark('android-touch-start')
    },
      {capture:true,passive:true,once:true,signal:controller.signal})
    const frame=at=>{
      samples.push([last,at]);last=at
      if(!state.stop&&samples.length<240)requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    resolve()
  })))
  await swipe()
  const after=await sample()
  const timing=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
    const state=globalThis.__runeAndroidScroll
    state.stop=true
    state.controller.abort()
    resolve({started:Number.isFinite(state.start),point:state.point,
      frames:state.samples.filter(([from,to])=>to>=state.start&&from<state.start+480).map(([from,to])=>to-from)})
  })))
  const {started,frames,point}=timing
  assert(started,'The native Android touch must reach the page')
  assert.notDeepEqual(before,after,`The native Android swipe must move the visible transcript: ${JSON.stringify(point)}`)
  assert(frames.length>=5,'The swipe must produce a usable frame sample')
  frames.sort((a,b)=>a-b)
  return {before,after,point,frames:frames.length,p50Ms:frames[Math.floor(frames.length*0.5)],
    p95Ms:frames[Math.min(frames.length-1,Math.floor(frames.length*0.95))],maxMs:frames.at(-1),
    over25Ms:frames.filter(ms=>ms>25).length}
}
