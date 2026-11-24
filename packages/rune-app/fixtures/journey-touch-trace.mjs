export async function traceJourneyTouch(page, labels) {
  await page.addInitScript((labels)=>{
    const names=new Set(labels)
    const mirror='[data-rune-a11y]'
    const records=[]
    const describe=node=>node instanceof Element?{
      tag:node.localName,role:node.getAttribute('role'),
      name:node.getAttribute('aria-label')??(node.matches('button,[role="tab"]')?node.textContent:null),
      class:typeof node.className==='string'?node.className:null,
    }:null
    const bounds=node=>{
      const {x,y,width,height}=node.getBoundingClientRect()
      return {x,y,width,height}
    }
    const snapshot=(x,y)=>{
      const canvas=document.querySelector('canvas')
      const focus=document.getElementById(canvas?.getAttribute('aria-activedescendant'))
      return {
        viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport?.scale},
        canvas:canvas&&bounds(canvas), focus:describe(focus),
        hit:Number.isFinite(x)&&Number.isFinite(y)?describe(document.elementFromPoint(x,y)):null,
        previewOpen:[...document.querySelectorAll(`${mirror} :is(section,[role="region"])`)].some(node=>node.getAttribute('aria-label')===labels.at(-1)),
        controls:[...document.querySelectorAll(`${mirror} button`)].flatMap(node=>{
          const control=describe(node)
          if(!names.has(control.name))return []
          return [{...control,box:bounds(node),selected:node.getAttribute('aria-selected'),
            expanded:node.getAttribute('aria-expanded'),pressed:node.getAttribute('aria-pressed')}]
        }),
      }
    }
    const trace=window.__journeyTouch={records,snapshot,gesture:null}
    const menus=new MutationObserver(changes=>{
      if(!trace.gesture||records.length>=96)return
      for(const {addedNodes} of changes)for(const node of addedNodes){
        if(!(node instanceof Element)||!node.matches('[data-rune-menu]'))continue
        records.push({type:'rune-menu',at:performance.now(),gesture:trace.gesture,box:bounds(node),
          items:[...node.querySelectorAll('[role^=menuitem]')].map(item=>item.textContent)})
      }
    })
    document.addEventListener('DOMContentLoaded',()=>menus.observe(document.body,{childList:true}),{once:true})
    for(const type of ['pointerdown','pointerup','pointercancel','touchstart','touchend','touchcancel','click']){
      window.addEventListener(type,event=>{
        if(!trace.gesture||records.length>=96)return
        const p=event.changedTouches?.[0]??event
        const {clientX:x,clientY:y}=p
        records.push({type,x,y,stamp:event.timeStamp,at:performance.now(),trusted:event.isTrusted,
          pointerId:event.pointerId,gesture:trace.gesture,target:describe(event.target),...snapshot(x,y)})
      },{capture:true,passive:true})
    }
  },labels)
}
