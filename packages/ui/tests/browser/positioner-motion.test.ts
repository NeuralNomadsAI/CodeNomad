import assert from "node:assert/strict"
import {after,before,test} from "node:test"
import {chromium,type Browser} from "playwright"
import {borrowFixture} from "./fixture-borrow"
import {armFixtureNavigationBudget} from "./fixture-navigation-budget"

let browser:Browser,url:string
before(async()=>{
  const fixture=await borrowFixture({name:"positioner-motion",routes:[{path:"/fixture",html:'<html><body style="margin:0"><div id="root"></div><script type="module" src="/tests/browser/fixtures/file-row-actions.tsx"></script></body></html>'}]})
  url=fixture.url
  browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  armFixtureNavigationBudget(browser)
})
after(async()=>{await browser?.close()})

for(const motion of ["reduce","no-preference"] as const)for(const mode of ["standalone","wrapped"]){
  test(`positioner lands before pointer release: ${mode}, ${motion}`,async()=>{
    const page=await browser.newPage({viewport:{width:480,height:260},reducedMotion:motion}),errors:string[]=[]
    page.on("pageerror",error=>errors.push(error.message))
    const origin=new URL(url).origin
    await page.route("**/*",route=>{
      const request=route.request(),target=new URL(request.url());assert.equal(target.origin,origin,"Fixture stays on its own loopback origin")
      if(!target.pathname.startsWith("/api/"))return route.continue()
      assert.equal(request.method(),"GET","Synthetic callbacks cannot write API state")
      return target.pathname==="/api/events"?route.fulfill({contentType:"text/event-stream",body:": fixture\n\n"}):route.fulfill({json:{}})
    })
    try{
      await page.goto(`${url}?mode=${mode}`)
      await page.waitForFunction(()=>Boolean((window as any).runeFileActions?.ready))
      await page.evaluate(()=>document.fonts.ready)
      await page.evaluate(()=> (window as any).runeFileActions.resize(110))
      await page.waitForFunction(()=>Math.abs(document.getElementById("frame")!.getBoundingClientRect().width-110)<0.1)
      await page.waitForFunction(()=>document.querySelector<HTMLElement>(".file-row-actions")?.dataset.compact==="true")
      await page.evaluate(()=>{
        ;(window as any).positionerSamples=[]
        document.addEventListener("pointerdown",event=>{
          if(!(event.target instanceof Element)||!event.target.closest('button[aria-label="Actions"]'))return
          const trigger=document.querySelector('button[aria-label="Actions"]')!,popup=document.querySelector<HTMLElement>('[role="menu"]')
          const positioner=popup?.closest<HTMLElement>("[data-popper-positioner]")
          if(!popup||!positioner)return
          const t=trigger.getBoundingClientRect(),p=popup.getBoundingClientRect(),style=getComputedStyle(positioner)
          const authored=new DOMMatrix(positioner.style.transform),computed=new DOMMatrix(style.transform)
          const hit=document.elementFromPoint(t.x+t.width/2,t.y+t.height/2)
          ;(window as any).positionerSamples.push({trigger:t.toJSON(),popup:p.toJSON(),authored:[authored.e,authored.f],computed:[computed.e,computed.f],transition:style.transitionProperty,hitPopup:Boolean(hit&&popup.contains(hit))})
        })
      })
      const trigger=page.getByRole("button",{name:"Actions",exact:true}),box=await trigger.boundingBox()
      assert(box);assert(box.x+box.width/2<190,"Trigger must intersect the unpositioned popup's potential origin")
      await trigger.click()
      await page.getByRole("menu").waitFor({state:"visible"})
      const samples=await page.evaluate(()=> (window as any).positionerSamples as {authored:number[],computed:number[],transition:string,hitPopup:boolean,trigger:{bottom:number},popup:{top:number}}[])
      assert.equal(samples.length,1,"Observe the actual opening pointerdown")
      const sample=samples[0]
      assert.deepEqual(sample.computed,sample.authored,"Positioning transforms must land during pointerdown")
      assert.equal(sample.hitPopup,false,"Popup must not take the trigger's pointer release")
      assert(sample.popup.top>=sample.trigger.bottom,"Actual popup starts below the trigger")
      assert.equal(await page.locator('button[aria-label="Actions"]').getAttribute("aria-expanded"),"true")
      const state=await page.evaluate(()=> (window as any).runeFileActions.state())
      assert(!state.trace.some((event:{event:string})=>["open","copy","disabled","preview"].includes(event.event)),"Opening never executes an action")
      assert.deepEqual(errors,[])
    }finally{await page.close()}
  })
}
