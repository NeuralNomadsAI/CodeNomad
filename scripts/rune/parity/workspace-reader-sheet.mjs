import {buildInventory} from '../component-inventory.mjs'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {readerScenes,sceneBytes} from './workspace-reader-scenes.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=path.join(root,'target/rune-parity/workspace-reader/sheets')
await mkdir(out,{recursive:true})
const names=['packages/ui/src/components/files-preview-view.tsx','packages/ui/src/components/workspace-file-view.tsx','packages/ui/src/components/file-viewer/monaco-file-viewer.tsx']
for(const [key,value] of await buildInventory(root))if(names.includes(value.source))await writeFile(path.join(out,path.basename(key)),JSON.stringify(value,null,2)+'\n')
const helpers=['packages/ui/src/components/workspace-file-editor.ts','packages/ui/src/lib/monaco/model-cache.ts','packages/ui/src/lib/render-text-window.ts','packages/ui/src/components/instance/shell/file-preview-lifetime.ts']
const modules=await Promise.all(helpers.map(async source=>{const text=(await readFile(path.join(root,source),'utf8')).replaceAll('\r\n','\n');return {source,sha256:createHash('sha256').update(text).digest('hex'),lines:text.split('\n').length,componentCandidate:false}}))
await writeFile(path.join(out,'helpers.json'),JSON.stringify({modules,limitation:'Helpers have no JSX component candidate; their behavior requires direct contract fixtures.'},null,2)+'\n')
await writeFile(path.join(out,'scene-inputs.json'),JSON.stringify({directory:'/trial-rune-reader',scenes:Object.entries(readerScenes).map(([id,scene])=>({id,path:scene.path,base64:Buffer.from(sceneBytes(scene)).toString('base64'),hold:!!scene.hold,fail:!!scene.fail}))},null,2)+'\n')
console.log(out)
