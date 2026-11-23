import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'
import {mobileClientHints,mobileContext} from './web-mobile.mjs'
import {bundleAssetPaths} from './web-workspace-policy.mjs'
import {privateEnvironment} from '../../packages/rune-app/fixtures/private-profile.mjs'

const bundle=path.resolve(process.argv[2]??'target/rune-web-loopback-links')
const output=path.resolve(process.argv[3]??'target/rune-loopback-link-evidence')
await mkdir(output,{recursive:true})
const assets=await bundleAssetPaths(bundle)
const host='rune-transcript.test'
const origin=`https://${host}`
const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.woff2':'font/woff2'}
const profile=await mkdtemp(path.join(output,'profile-'))
let browser
try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined,
        env:await privateEnvironment(profile),args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
    const context=await browser.newContext({...mobileContext(browser),colorScheme:'light',serviceWorkers:'block'})
    await context.addInitScript(()=>{
        let text=''
        Object.defineProperty(navigator,'clipboard',{value:{
            readText:async()=>text, writeText:async value=>{text=value},
        }})
    })
    const page=await context.newPage()
    const destinations=[],refused=[]
    await context.route('**/*',async route=>{
        const url=new URL(route.request().url())
        if(url.origin===origin&&assets.has(url.pathname)){
            const name=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)
            return route.fulfill({path:path.join(bundle,name),contentType:mime[path.extname(name)]})
        }
        if(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.port==='8123'&&['/view','/bare'].includes(url.pathname)
            &&route.request().isNavigationRequest()){
            destinations.push(url.href)
            return route.fulfill({contentType:'text/plain',body:'Dedicated external tab'})
        }
        refused.push(url.href)
        return route.abort()
    })
    const cdp=await mobileClientHints(page,browser)
    await page.goto(`${origin}/?locale=en&scene=transcript-loopback`,{waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>globalThis.__codenomadRuneBoot?.state==='ready')
    const history=page.locator('[data-rune-a11y]')
    const cases=[
        ['IPv4','http://127.0.0.1:8123/view?a=1#top'],
        ['IPv6','https://[::1]:8123/view?a=1#top'],
        ['Name','http://localhost:8123/view?a=1#top'],
        ['http://localhost:8123/bare','http://localhost:8123/bare'],
    ]
    for(const [name,target] of cases){
        const link=history.getByRole('link',{name,exact:true})
        await link.waitFor()
        assert.equal(await link.getAttribute('href'),target)
        assert.equal(await link.getAttribute('target'),'_blank')
        assert.match(await link.getAttribute('rel'),/\bnoopener\b/)
    }
    assert.equal(await history.getByRole('link',{name:'Ordinary'}).getAttribute('href'),'https://127.0.0.1.example.org/')
    assert.deepEqual(destinations,[],'Rendering must not open a link')
    for(const [name,target] of cases){
        const link=history.getByRole('link',{name,exact:true})
        const box=await link.boundingBox()
        assert(box)
        const popup=page.waitForEvent('popup')
        await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
        const tab=await popup
        await tab.waitForURL(target)
        await tab.close()
        assert.equal(new URL(page.url()).origin,origin,'The transcript stays open')
    }
    assert.equal(destinations.length,cases.length)
    const box=await history.getByRole('link',{name:'IPv6',exact:true}).boundingBox()
    assert(box)
    const choose=async name=>{
        const action=page.getByRole('menuitem',{name,exact:true})
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]})
        try{
            await action.waitFor({timeout:10000})
            await page.getByText('This address opens on your device. For the server’s service, open it on the server.',{exact:true}).waitFor()
        }
        finally{await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}
        await action.click()
    }
    await choose('Copy link')
    await page.waitForFunction(expected=>navigator.clipboard.readText().then(value=>value===expected),cases[1][1])
    assert.equal(destinations.length,cases.length,'Copy does not open the destination')
    const pending=page.waitForEvent('popup')
    await choose('Open')
    const fromMenu=await pending
    await fromMenu.waitForURL(cases[1][1])
    await fromMenu.close()
    assert.equal(destinations.length,cases.length+1)
    assert.deepEqual(refused,[])
    await writeFile(path.join(output,'transcript.aria.yml'),await history.ariaSnapshot())
    await page.screenshot({path:path.join(output,'transcript.png'),scale:'css'})
    console.log(JSON.stringify({mobile:true,destinations,output}))
}finally{
    try{await browser?.close()}finally{await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
}
