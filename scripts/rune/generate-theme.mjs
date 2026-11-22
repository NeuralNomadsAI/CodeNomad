import assert from 'node:assert/strict'
import {readFile,mkdir,readdir,writeFile,copyFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from 'playwright'
import {root,generated,sources} from './generate-common.mjs'
import {collectTheme} from './generate-theme-browser.mjs'
import {themeFixtureHtml} from './generate-theme-fixture.mjs'
import {generateWorkspaceIcons} from './parity/workspace-tree-row-icons.mjs'
import {sourcePath} from './parity/workspace-tree-row-source.mjs'
import {createSourceFixture,assertSourceDiagnostics,contextInputs} from './parity/source-context.mjs'

const ui=path.join(root,'packages/ui'),tokens=path.join(ui,'src/styles/tokens.css')
const css=await readFile(tokens,'utf8'),names=[...new Set([...css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)].map(m=>m[1]))].sort()
assert(names.length>100,'Expected the shared CodeNomad theme, not a theme subset')
const evidence=path.join(root,'target/rune-source-theme-context');await mkdir(evidence,{recursive:true})
const markup=/<body>([\s\S]*)<\/body>/.exec(themeFixtureHtml)?.[1];assert(markup,'Theme contract body required')
const fixture=await createSourceFixture('scripts/rune/generate-theme.fixture.tsx','rune-generated-source-theme',markup)
let browser
const out={name:'CodeNomad',blend:{mode:'srgb',over:'surface-canvas'},context:{policy:'source-default-configuration',appearances:{},dependencies:fixture.dependencies.packages},light:{},dark:{},numbers:{},strings:{},shadows:{},metrics:{},gaps:[
  'Rune-kit control geometry includes internal constants; CodeNomad shared adapters require visual qualification.',
  'CSS timing functions and Rune perceptual-duration springs have different curves; motion parity requires interaction captures.',
  'System font stacks are preserved as source strings; glyph metrics require per-platform image qualification.',
]}
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  for(const appearance of ['light','dark']){
    const {page,diagnostics}=await fixture.open(browser,{theme:appearance},{width:1024,height:768})
    await page.emulateMedia({reducedMotion:'no-preference'})
    await page.keyboard.press('Tab')
    assert(await page.locator('.window-icon-button').evaluate(e=>e.matches(':focus-visible')),
      'Window icon focus metrics must come from real keyboard focus')
    const value=await page.evaluate(collectTheme,names)
    assert.equal(value.unresolved.length,0,`Unresolved ${appearance} tokens: ${value.unresolved.join(', ')}`)
    out[appearance]=value.colors
    for(const field of ['numbers','strings','shadows','metrics'])out[field][appearance]=value[field]
    out.context.appearances[appearance]=await page.evaluate(()=>window.runeSourceContext.snapshot())
    assertSourceDiagnostics(diagnostics)
    await page.close()
  }
  const files=[tokens,path.join(root,sourcePath),path.join(ui,'src/index.css'),path.join(ui,'tailwind.config.js'),path.join(ui,'postcss.config.js'),...contextInputs.map(file=>path.join(root,file)),...['CssBaseline/CssBaseline.jsx','styles/createTypography.jsx','styles/createTheme.jsx'].map(file=>path.join(root,'node_modules/@suid/material',file))]
  async function walk(folder){for(const entry of await readdir(folder,{withFileTypes:true})){
    const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else if(file.endsWith('.css'))files.push(file)
  }}
  await walk(path.join(ui,'src/styles'))
  out.sources=await sources(files)
  await generated('assets/theme.json',out)
  await generateWorkspaceIcons()
  await writeFile(path.join(evidence,'generation-environment.json'),JSON.stringify({dependencies:fixture.dependencies,browser:browser.version(),context:out.context},null,2)+'\n')
}finally{
  await browser?.close()
  await fixture.close()
  await copyFile(path.join(fixture.logDirectory,'daemon.log'),path.join(evidence,'generation-daemon.log'))
}
