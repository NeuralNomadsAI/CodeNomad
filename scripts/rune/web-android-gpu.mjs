export function observeGpu() {
  const gpu=navigator.gpu
  const records=globalThis.__androidGpuAdapters=[]
  const describe=async adapter=>{
    if(!adapter)return null
    const info=adapter.info??await adapter.requestAdapterInfo?.().catch(()=>null)
    return {...Object.fromEntries(['vendor','architecture','device','description','backend','isFallbackAdapter']
      .map(key=>[key,info?.[key]??adapter[key]??null])),maxTextureDimension2D:adapter.limits.maxTextureDimension2D}
  }
  if(!gpu)return
  const request=gpu.requestAdapter.bind(gpu)
  gpu.requestAdapter=async options=>{
    const row={options:options??null,startedAt:performance.now()}
    records.push(row)
    try {
      const adapter=await request(options)
      row.adapter=await describe(adapter)
      return adapter
    }catch(error){row.error=String(error);throw error}
  }
}

export async function gpuState(page, includeControls=false) {
  return page.evaluate(async includeControls=>{
    const appRequests=structuredClone(globalThis.__androidGpuAdapters??[])
    const controls={}
    if(includeControls&&navigator.gpu){
      for(const [key,option] of [['default',undefined],['lowPower',{powerPreference:'low-power'}],['forcedFallback',{forceFallbackAdapter:true}]]){
        try { await navigator.gpu.requestAdapter(option) }catch{}
        controls[key]=globalThis.__androidGpuAdapters.at(-1)
      }
    }
    const canvases=[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height,opacity:getComputedStyle(c).opacity}))
    let webgl
    if(includeControls){
      const gl=document.createElement('canvas').getContext('webgl2')
      const ext=gl?.getExtension('WEBGL_debug_renderer_info')
      webgl=gl&&{version:gl.getParameter(gl.VERSION),renderer:ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}
    }
    return {secureContext:isSecureContext,webgpu:Boolean(navigator.gpu),webgl,appRequests,controls,canvases,
      contexts:globalThis.__runeGraphicsContexts,marks:performance.getEntriesByType('mark').map(({name,startTime})=>({name,startTime}))}
  },includeControls)
}

export async function chromeGraphicsReport(context,page) {
  const diagnostic=await context.newPage()
  try {
    await diagnostic.goto('chrome://gpu',{waitUntil:'domcontentloaded',timeout:5000})
    await diagnostic.getByText('Graphics Feature Status',{exact:true}).waitFor({timeout:5000})
    return await diagnostic.evaluate(()=>{
      const collect=root=>[...root.querySelectorAll('*')].flatMap(el=>el.shadowRoot?
        [...el.shadowRoot.children].filter(n=>n.tagName!=='STYLE').map(n=>n.innerText).concat(collect(el.shadowRoot)):[])
      return [document.body.innerText,...collect(document)].filter(Boolean).join('\n').slice(0,100000)
    })
  }catch(error){return error.message}
  finally {await diagnostic.close();await page.bringToFront()}
}
