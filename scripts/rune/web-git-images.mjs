import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'

const names=['sample.svg','sample.avif']
const avifPrefix='AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAbAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAIAAAACAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAjbWRhdAoFGAi/bAIyEhgAAABQ'
const svg = fill => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect width="32" height="32" fill="${fill}"/></svg>`
export async function seedGitImages(project, git){
  await git('init','--quiet','-b','main')
  await writeFile(path.join(project,names[0]),svg('#ff0000'))
  await writeFile(path.join(project,names[1]),Buffer.from(`${avifPrefix}AABAA1Lt5xf080WmIA==`,'base64'))
  await git('add','--',...names)
  await git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Image fixtures')
  await writeFile(path.join(project,names[0]),svg('#0000ff'))
  await writeFile(path.join(project,names[1]),Buffer.from(`${avifPrefix}AAAAALATUT8UTny0YA==`,'base64'))
}

export async function gitImageReadAllowed(request,{origin,workspaces,project}){
  const url=new URL(request.url())
  const match=url.pathname.match(/^\/api\/workspaces\/([^/]+)\/(files|worktrees\/root\/git-(?:status|diff))$/)
  if(!match||url.origin!==origin||request.method()!=='GET'||!workspaces.has(match[1]))return false
  const params=url.searchParams, keys=[...params.keys()]
  if(keys.length!==new Set(keys).size)return false
  const tail=match[2]
  const allowed=tail==='files'
    ? keys.every(key=>['path','directory'].includes(key))&&['','.'].includes(params.get('path')??'')&&
      (process.platform==='win32'
        ? params.get('directory')?.replaceAll('\\','/').toLowerCase()===project.replaceAll('\\','/').toLowerCase()
        : params.get('directory')===project)
    : tail.endsWith('git-status')
      ? keys.every(key=>key==='hideWhitespace')&&(params.get('hideWhitespace')??'1')==='1'
      : keys.length===2&&params.get('scope')==='unstaged'&&names.includes(params.get('path'))
  return allowed&&!!(await request.allHeaders()).cookie
}

export async function checkGitImages(page,messages,press,out){
  const right=messages['window.menu.rightPanel']
  if(await page.getByRole('button',{name:right,exact:true}).getAttribute('aria-expanded')!=='true')await press(right)
  await press(messages['instanceShell.rightPanel.tabs.files'],'tab')
  await press(messages['gitPanel.changes'],'radio')
  const reader=page.getByRole('region',{name:messages['gitPanel.diff'],exact:true})
  for(const name of names){
    const translated=messages['filesPanel.viewer']
    const [response]=await Promise.all([
      page.waitForResponse(response=>new URL(response.url()).searchParams.get('path')===name
        &&new URL(response.url()).pathname.endsWith('/git-diff')),
      press(`${translated} · ${name}`),
    ])
    assert(response.ok(),`${name} diff: ${response.status()} ${await response.text()}`)
    const wire=await response.json()
    assert.equal(wire.image.mime,name.endsWith('.svg')?'image/svg+xml':'image/avif')
    assert(wire.image.before&&wire.image.after&&wire.image.before!==wire.image.after)
    for(const [side,channel] of [['before',0],['after',2]]){
      const img=reader.getByRole('img',{name:`${name} · ${messages[`filesPanel.image.${side}`]}`,exact:true})
      await img.waitFor()
      const box=await img.boundingBox()
      assert(box&&box.width>=8&&box.height>=8)
      const pixel=await page.screenshot({clip:{x:Math.floor(box.x+box.width/2),y:Math.floor(box.y+box.height/2),width:1,height:1}})
      const rgba=await page.evaluate(async bytes=>{
        const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}))
        const canvas=new OffscreenCanvas(1,1), ctx=canvas.getContext('2d')
        ctx.drawImage(bitmap,0,0)
        bitmap.close()
        return [...ctx.getImageData(0,0,1,1).data]
      },[...pixel])
      assert(rgba[channel]>180&&rgba[2-channel]<70,`${name} ${side}: ${rgba}`)
    }
    await page.screenshot({path:`${out}-${name}.png`})
    await writeFile(`${out}-${name}.aria.yml`,await reader.ariaSnapshot())
  }
  await press(messages['gitPanel.backChat'])
  await reader.waitFor({state:'detached'})
}
