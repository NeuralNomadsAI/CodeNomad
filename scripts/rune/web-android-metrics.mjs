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

export async function scrollMeasure(page,swipe) {
  const sample=()=>page.evaluate(()=>{
    const viewport=visualViewport.height
    return [...document.querySelectorAll('[data-rune-a11y] p')]
      .filter(el=>el.textContent.startsWith('Mobile history row '))
      .map(el=>[el.textContent,Math.round(el.getBoundingClientRect().top)])
      .filter(([,y])=>y>=130&&y<viewport-180)
  })
  const before=await sample()
  assert(before.length,'The private transcript must be painted before measuring scroll')
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(now=>{
    const samples=[]
    let last=now
    globalThis.__runeAndroidScroll={samples,stop:false}
    const frame=at=>{
      samples.push(at-last);last=at
      if(!globalThis.__runeAndroidScroll.stop&&samples.length<240)requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    resolve()
  })))
  await swipe()
  const after=await sample()
  const frames=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
    const state=globalThis.__runeAndroidScroll
    state.stop=true
    resolve(state.samples.slice(1))
  })))
  assert.notDeepEqual(before,after,'The native Android swipe must move the visible transcript')
  assert(frames.length>=5,'The swipe must produce a usable frame sample')
  frames.sort((a,b)=>a-b)
  return {before,after,frames:frames.length,p50Ms:frames[Math.floor(frames.length*0.5)],
    p95Ms:frames[Math.min(frames.length-1,Math.floor(frames.length*0.95))],maxMs:frames.at(-1),
    over25Ms:frames.filter(ms=>ms>25).length}
}
