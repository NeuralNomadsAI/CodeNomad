import {createWriteStream} from 'node:fs'
import {finished} from 'node:stream/promises'
import {once} from 'node:events'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'

export async function traceSwipe(page,cdp,profile,swipe,mode) {
  const complete=once(cdp,'Tracing.tracingComplete')
  await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',
    categories:mode==='display'?'blink.user_timing,cc,viz':
      mode==='stutter'?'blink.user_timing,cc,viz,gpu,disabled-by-default-gpu.service,devtools.timeline,v8,disabled-by-default-v8.gc':
      'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,input,latencyInfo,cc,viz,gpu,v8,disabled-by-default-v8.cpu_profiler'})
  try {
    await page.evaluate(()=>{
      globalThis.__runeAndroidTracing=true
      globalThis.__runeCpuFrames?.splice(0)
      performance.mark('android-swipe-start')
    })
    return await swipe()
  } finally {
    const stats=await page.evaluate(()=>{
      performance.mark('android-swipe-end')
      globalThis.__runeAndroidTracing=false
      return {
        canvases:[...document.querySelectorAll('canvas')].map(canvas=>({width:canvas.width,height:canvas.height})),
        webgpu:Boolean(navigator.gpu),cpuFrames:globalThis.__runeCpuFrames,contexts:globalThis.__runeGraphicsContexts,
        marks:performance.getEntriesByType('mark').map(({name,startTime})=>({name,startTime})),
      }
    }).catch(()=>null)
    await cdp.send('Tracing.end')
    const [{stream}]=await complete
    const output=createWriteStream(path.join(profile,'android-scroll-trace.json'))
    try {
      for(;;){
        const {data,eof,base64Encoded}=await cdp.send('IO.read',{handle:stream})
        if(!output.write(data,base64Encoded?'base64':'utf8'))await once(output,'drain')
        if(eof)break
      }
      output.end()
      await finished(output)
    } finally {
      output.destroy()
      await cdp.send('IO.close',{handle:stream})
    }
    await writeFile(path.join(profile,'android-renderer.json'),JSON.stringify(stats,null,2))
  }
}

export function observeRenderer({recordCpu,shaderMarks}={}) {
  if(recordCpu)globalThis.__runeCpuFrames=[]
  globalThis.__runeGraphicsContexts=[]
  const getContext=HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext=function(...args) {
    const value=Reflect.apply(getContext,this,args)
    if(this.isConnected&&value&&!globalThis.__runeGraphicsContexts.includes(args[0]))globalThis.__runeGraphicsContexts.push(args[0])
    return value
  }
  if(shaderMarks&&globalThis.WebGL2RenderingContext){
    const gl=WebGL2RenderingContext.prototype
    for(const name of ['compileShader','linkProgram']){
      const call=gl[name]
      gl[name]=function(...args){
        const start=performance.now()
        try{return Reflect.apply(call,this,args)}
        finally{performance.measure(`android.gl.${name}`,{start,end:performance.now()})}
      }
    }
  }
}
